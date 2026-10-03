#!/usr/bin/env python3
"""Scan data/overlays for GeoJSON and GeoTIFF files and return map-ready overlay layers."""

import base64
import json
import os
import struct
import sys
import zlib
from typing import Any

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.warp import Resampling, calculate_default_transform, reproject, transform_bounds
import shapely

SUPPORTED_GEOJSON_EXTS = {'.geojson'}
SUPPORTED_GEOTIFF_EXTS = {'.tif', '.tiff', '.geotif', '.geotiff'}

LAYER_PALETTE = [
    '#38bdf8',  # sky blue
    '#f97316',  # orange
    '#a855f7',  # purple
    '#10b981',  # emerald
    '#ef4444',  # red
    '#eab308',  # yellow
    '#ec4899',  # pink
    '#14b8a6',  # teal
]


def hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
  h = hex_color.lstrip('#')
  return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def encode_rgba_png_data_url(rgba: np.ndarray) -> str:
  """Encode a HxWx4 uint8 RGBA numpy array into a base64 PNG data URL."""
  h, w, _ = rgba.shape
  raw_rows = b''.join(b'\x00' + rgba[y].tobytes() for y in range(h))

  def make_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack('!I', len(data))
        + tag
        + data
        + struct.pack('!I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    )

  ihdr = struct.pack('!IIBBBBB', w, h, 8, 6, 0, 0, 0)
  png_bytes = (
      b'\x89PNG\r\n\x1a\n'
      + make_chunk(b'IHDR', ihdr)
      + make_chunk(b'IDAT', zlib.compress(raw_rows, 6))
      + make_chunk(b'IEND', b'')
  )
  return 'data:image/png;base64,' + base64.b64encode(png_bytes).decode('ascii')


def load_geojson_overlay(filepath: str, name: str, filename: str, color: str) -> dict[str, Any]:
  """Load a GeoJSON file, reproject to EPSG:4326 if needed, and strip 3D Z coords."""
  gdf = gpd.read_file(filepath)
  if gdf.crs is not None:
    epsg = gdf.crs.to_epsg()
    if epsg != 4326:
      gdf = gdf.to_crs('EPSG:4326')

  # Ensure 2D coordinates for clean Leaflet rendering and smaller payload
  gdf['geometry'] = shapely.force_2d(gdf['geometry'])
  geojson_dict = json.loads(gdf.to_json())

  # Compute simplified geometry via Shapely: g.simplify(tolerance=0.0005, preserve_topology=True)
  simplified_gdf = gdf.copy()
  simplified_gdf['geometry'] = simplified_gdf['geometry'].apply(
      lambda g: g.simplify(tolerance=0.0005, preserve_topology=True) if g is not None else None
  )
  simplified_geojson_dict = json.loads(simplified_gdf.to_json())

  return {
      'id': filename,
      'name': name,
      'fileName': filename,
      'format': 'geojson',
      'color': color,
      'featureCount': int(len(gdf)),
      'geojson': geojson_dict,
      'simplifiedGeojson': simplified_geojson_dict,
  }


def load_geotiff_overlay(filepath: str, name: str, filename: str, color: str) -> dict[str, Any]:
  """Load a GeoTIFF file, reproject to EPSG:4326 if needed, and encode as RGBA PNG dataUrl."""
  dst_crs = 'EPSG:4326'
  with rasterio.open(filepath) as src:
    src_crs = src.crs
    nodata = src.nodata

    if src_crs is not None and src_crs.to_string() != dst_crs:
      transform, width, height = calculate_default_transform(
          src_crs, dst_crs, src.width, src.height, *src.bounds
      )
      # Cap max dimension to 1024px to keep payload fast and responsive
      max_dim = 1024
      if width > max_dim or height > max_dim:
        scale = max_dim / float(max(width, height))
        width = max(1, int(round(width * scale)))
        height = max(1, int(round(height * scale)))
        transform, width, height = calculate_default_transform(
            src_crs,
            dst_crs,
            src.width,
            src.height,
            *src.bounds,
            dst_width=width,
            dst_height=height,
        )

      left, bottom, right, top = transform_bounds(src_crs, dst_crs, *src.bounds)
      bands_to_read = min(src.count, 4)
      data = np.full((bands_to_read, height, width), np.nan, dtype=np.float64)
      for b_idx in range(1, bands_to_read + 1):
        reproject(
            source=rasterio.band(src, b_idx),
            destination=data[b_idx - 1],
            src_transform=src.transform,
            src_crs=src_crs,
            src_nodata=nodata,
            dst_transform=transform,
            dst_crs=dst_crs,
            dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )
    else:
      bounds = src.bounds
      left, bottom, right, top = (
          float(bounds.left),
          float(bounds.bottom),
          float(bounds.right),
          float(bounds.top),
      )
      bands_to_read = min(src.count, 4)
      raw = src.read(list(range(1, bands_to_read + 1))).astype(np.float64)
      if nodata is not None:
        raw[raw == nodata] = np.nan
      data = raw
      _, height, width = data.shape

    leaflet_bounds = [[float(bottom), float(left)], [float(top), float(right)]]

    if bands_to_read >= 3 and src.dtypes[0] == 'uint8':
      r = np.nan_to_num(data[0], nan=0.0).clip(0, 255).astype(np.uint8)
      g = np.nan_to_num(data[1], nan=0.0).clip(0, 255).astype(np.uint8)
      b = np.nan_to_num(data[2], nan=0.0).clip(0, 255).astype(np.uint8)
      if bands_to_read >= 4:
        a = np.nan_to_num(data[3], nan=0.0).clip(0, 255).astype(np.uint8)
      else:
        valid = ~np.isnan(data[0])
        a = np.where(valid, 220, 0).astype(np.uint8)
      rgba = np.stack([r, g, b, a], axis=-1)
    else:
      band = data[0]
      valid_mask = ~np.isnan(band)
      if np.any(valid_mask):
        vmin = float(np.nanmin(band))
        vmax = float(np.nanmax(band))
      else:
        vmin, vmax = 0.0, 1.0

      # If minimum is 0 and maximum > 0, treat <= 0 as transparent background
      if vmin >= 0.0 and vmax > 0.0:
        visible_mask = valid_mask & (band > 0.0)
      else:
        visible_mask = valid_mask

      if vmax > vmin:
        norm = np.clip(( np.where(valid_mask, band, vmin) - vmin ) / (vmax - vmin), 0.0, 1.0)
      else:
        norm = np.where(visible_mask, 1.0, 0.0)

      cr, cg, cb = hex_to_rgb(color)
      # Interpolate from light tint (50% white + 50% layer color) to full layer color
      r = np.round((0.5 * 255 + 0.5 * cr) * (1.0 - norm) + cr * norm).astype(np.uint8)
      g = np.round((0.5 * 255 + 0.5 * cg) * (1.0 - norm) + cg * norm).astype(np.uint8)
      b = np.round((0.5 * 255 + 0.5 * cb) * (1.0 - norm) + cb * norm).astype(np.uint8)
      a = np.where(visible_mask, 215, 0).astype(np.uint8)
      rgba = np.stack([r, g, b, a], axis=-1)

    data_url = encode_rgba_png_data_url(rgba)

  return {
      'id': filename,
      'name': name,
      'fileName': filename,
      'format': 'geotiff',
      'color': color,
      'dataUrl': data_url,
      'bounds': leaflet_bounds,
  }


def main() -> None:
  base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
  overlays_dir = os.path.join(base_dir, 'data', 'overlays')

  if not os.path.isdir(overlays_dir):
    print(json.dumps({'overlays': []}))
    return

  entries = sorted(os.listdir(overlays_dir))
  overlays: list[dict[str, Any]] = []
  color_idx = 0

  for fname in entries:
    fpath = os.path.join(overlays_dir, fname)
    if not os.path.isfile(fpath):
      continue
    stem, ext = os.path.splitext(fname)
    ext_lower = ext.lower()
    if ext_lower not in SUPPORTED_GEOJSON_EXTS and ext_lower not in SUPPORTED_GEOTIFF_EXTS:
      continue

    color = LAYER_PALETTE[color_idx % len(LAYER_PALETTE)]
    color_idx += 1

    try:
      if ext_lower in SUPPORTED_GEOJSON_EXTS:
        overlays.append(load_geojson_overlay(fpath, stem, fname, color))
      elif ext_lower in SUPPORTED_GEOTIFF_EXTS:
        overlays.append(load_geotiff_overlay(fpath, stem, fname, color))
    except Exception as exc:
      sys.stderr.write(f'Error loading overlay {fname}: {exc}\n')

  print(json.dumps({'overlays': overlays}))


if __name__ == '__main__':
  main()
