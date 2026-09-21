#!/usr/bin/env python3
"""Download CEMS GloFAS river discharge forecast (GRIB2) and convert to GeoTIFF.

Dataset:
  CEMS Early Warning Data Store (EWDS) - `cems-glofas-forecast`
  https://ewds.climate.copernicus.eu/datasets/cems-glofas-forecast?tab=download

Parametrization:
  - System version: operational, version 3.1
  - Hydrological model: LISFLOOD
  - Product type: control forecast
  - Variable: river discharge in the last 24 hours
  - Date: current date (YYYY-MM-DD, defaults to today UTC)
  - Leadtimes: 24, 48, and 72 hours (3-band GeoTIFF)
  - Region: configurable 100 km radius around map center point (lat, lon)
  - Storage directory: `tmp_downloads/`
  - Automatic cleanup: deletes any files from previous days in `tmp_downloads/`
  - Caching: reuses existing GeoTIFF for today if already present in `tmp_downloads/`
  - Color map rendering: clips values > 80 to 80 and maps 0 (white) -> 80 (red)
"""

import argparse
import base64
import datetime
import json
from pathlib import Path
import struct
import zlib

# IMPORTANT: Import rasterio and rioxarray before cfgrib/eccodes to prevent
# shared C library (GDAL vs ecCodes/eckit) teardown conflicts on exit.
import rasterio
import rioxarray  # noqa: F401
import cdsapi
import numpy as np
from pyproj import Geod
import xarray as xr


DEFAULT_LAT = 50.8503
DEFAULT_LON = 4.3517
DEFAULT_RADIUS_METERS = 100_000.0  # 100 km radius
TRANSPARENT_BELOW_DISCHARGE = 10.0
CLIP_MAX_DISCHARGE = 80.0


def get_tmp_downloads_dir() -> Path:
  """Return the project-level `tmp_downloads` directory, creating it if needed."""
  project_root = Path(__file__).resolve().parent.parent
  tmp_dir = project_root / "tmp_downloads"
  tmp_dir.mkdir(parents=True, exist_ok=True)
  return tmp_dir


def cleanup_previous_days_files(tmp_dir: Path, today_str: str) -> list[str]:
  """Delete every file in `tmp_downloads` from previous days (not matching today_str)."""
  deleted_files: list[str] = []
  if not tmp_dir.exists():
    return deleted_files

  for item in tmp_dir.iterdir():
    if not item.is_file():
      continue
    # Delete any file whose filename does not contain today's date string
    if today_str not in item.name:
      try:
        item.unlink()
        deleted_files.append(item.name)
      except OSError:
        pass
  return deleted_files


def compute_bounding_box(lat: float, lon: float, radius_m: float) -> list[float]:
  """Compute [North, West, South, East] bounding box on WGS84 ellipsoid."""
  geod = Geod(ellps="WGS84")
  _, north, _ = geod.fwd(lon, lat, 0, radius_m)
  east, _, _ = geod.fwd(lon, lat, 90, radius_m)
  _, south, _ = geod.fwd(lon, lat, 180, radius_m)
  west, _, _ = geod.fwd(lon, lat, 270, radius_m)
  return [round(north, 2), round(west, 2), round(south, 2), round(east, 2)]


def download_glofas_grib2(
    grib_path: Path,
    target_date: datetime.date,
    area: list[float],
) -> Path:
  """Download GloFAS river discharge forecast in GRIB2 format via EWDS API."""
  client = cdsapi.Client()

  dataset = "cems-glofas-forecast"
  request = {
      "system_version": ["operational", "version_3_1"],
      "hydrological_model": ["lisflood"],
      "product_type": ["control_forecast"],
      "variable": ["river_discharge_in_the_last_24_hours"],
      "year": [f"{target_date.year:04d}"],
      "month": [f"{target_date.month:02d}"],
      "day": [f"{target_date.day:02d}"],
      "leadtime_hour": ["24", "48", "72"],
      "data_format": "grib2",
      "download_format": "unarchived",
      "area": area,  # [North, West, South, East]
  }

  print(f"Requesting dataset '{dataset}' for {target_date.isoformat()}...")
  print(f"Bounding box [N, W, S, E]: {area}")
  client.retrieve(dataset, request, str(grib_path))
  print(f"Downloaded GRIB2 file to: {grib_path}")
  return grib_path


def convert_grib2_to_geotiff(grib_path: Path, geotiff_path: Path) -> Path:
  """Convert downloaded GloFAS GRIB2 file to a multi-band GeoTIFF."""
  ds = xr.open_dataset(grib_path, engine="cfgrib")
  print("\nOpened GRIB2 dataset:")
  print(ds)

  # Identify the primary data variable (e.g., 'dis24')
  var_name = list(ds.data_vars)[0]
  da = ds[var_name]

  # Ensure standard spatial dimension names and CRS for rioxarray
  da = da.rio.set_spatial_dims(x_dim="longitude", y_dim="latitude")
  da = da.rio.write_crs("EPSG:4326")

  # Write multi-band GeoTIFF (one band per forecast lead time: 24h, 48h, 72h)
  da.rio.to_raster(geotiff_path, driver="GTiff")

  # Annotate each band description with its leadtime in hours
  if "step" in da.coords:
    steps_hours = [
        int(np.timedelta64(s, "h") / np.timedelta64(1, "h"))
        for s in np.atleast_1d(da.coords["step"].values)
    ]
    with rasterio.open(geotiff_path, "r+") as dst:
      for idx, hours in enumerate(steps_hours, start=1):
        dst.set_band_description(
            idx, f"river_discharge_24h_leadtime_{hours}h (m3/s)"
        )

  print(f"\nSaved final GeoTIFF deliverable to: {geotiff_path}")
  return geotiff_path


def encode_rgba_png_data_url(rgba: np.ndarray) -> str:
  """Encode a HxWx4 uint8 RGBA numpy array into a base64 PNG data URL."""
  h, w, _ = rgba.shape
  raw_rows = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))

  def make_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack("!I", len(data))
        + tag
        + data
        + struct.pack("!I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )

  ihdr = struct.pack("!IIBBBBB", w, h, 8, 6, 0, 0, 0)
  png_bytes = (
      b"\x89PNG\r\n\x1a\n"
      + make_chunk(b"IHDR", ihdr)
      + make_chunk(b"IDAT", zlib.compress(raw_rows, 6))
      + make_chunk(b"IEND", b"")
  )
  return "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")


def render_geotiff_bands_to_overlays(geotiff_path: Path) -> tuple[list[list[float]], list[dict]]:
  """Read the 3-band GeoTIFF, make pixels < 10 fully transparent, clip > 80 to 80, and render White->Red RGBA overlays."""
  leadtimes = [24, 48, 72]
  overlays = []

  with rasterio.open(geotiff_path) as src:
    bounds = src.bounds
    leaflet_bounds = [
        [float(bounds.bottom), float(bounds.left)],
        [float(bounds.top), float(bounds.right)],
    ]

    for band_idx in range(1, min(src.count, 3) + 1):
      raw_band = src.read(band_idx).astype(np.float64)
      raw_min = float(np.nanmin(raw_band)) if np.any(~np.isnan(raw_band)) else 0.0
      raw_max = float(np.nanmax(raw_band)) if np.any(~np.isnan(raw_band)) else 0.0

      # Upsample by 8x nearest-neighbor so pixels are sharp on interactive Leaflet map
      upsampled = np.repeat(np.repeat(raw_band, 8, axis=0), 8, axis=1)
      valid_mask = ~np.isnan(upsampled)
      # Pixels below 10 m3/s appear as fully transparent (alpha = 0);
      # only pixels above 10 m3/s appear on the map and are subject to the transparency slider.
      visible_mask = valid_mask & (upsampled > TRANSPARENT_BELOW_DISCHARGE)

      # Clip every pixel value above 80 to 80 (and below 0 to 0)
      clipped = np.clip(np.where(valid_mask, upsampled, 0.0), 0.0, CLIP_MAX_DISCHARGE)
      norm = clipped / CLIP_MAX_DISCHARGE  # 0.0 -> White (#FFFFFF), 1.0 -> Red (#FF0000)

      # White (255, 255, 255) to Red (255, 0, 0) scale color map
      r = np.full_like(norm, 255, dtype=np.uint8)
      g = np.round(255.0 * (1.0 - norm)).astype(np.uint8)
      b = np.round(255.0 * (1.0 - norm)).astype(np.uint8)
      a = np.where(visible_mask, 255, 0).astype(np.uint8)

      rgba = np.stack([r, g, b, a], axis=-1)
      data_url = encode_rgba_png_data_url(rgba)

      leadtime_hr = leadtimes[band_idx - 1] if band_idx - 1 < len(leadtimes) else band_idx * 24
      overlays.append({
          "band": band_idx,
          "leadtimeHours": leadtime_hr,
          "label": f"{leadtime_hr}h Forecast",
          "description": src.descriptions[band_idx - 1] or f"river_discharge_24h_leadtime_{leadtime_hr}h (m3/s)",
          "rawMin": round(raw_min, 2),
          "rawMax": round(raw_max, 2),
          "transparentBelow": TRANSPARENT_BELOW_DISCHARGE,
          "clippedMax": CLIP_MAX_DISCHARGE,
          "dataUrl": data_url,
          "bounds": leaflet_bounds,
      })

  return leaflet_bounds, overlays


def main() -> None:
  parser = argparse.ArgumentParser(
      description="Download CEMS GloFAS river discharge forecast (24h, 48h, 72h) into tmp_downloads/"
  )
  parser.add_argument("--lat", type=float, default=DEFAULT_LAT, help="Center latitude")
  parser.add_argument("--lon", type=float, default=DEFAULT_LON, help="Center longitude")
  parser.add_argument(
      "--date",
      type=str,
      default=datetime.datetime.now(datetime.timezone.utc).date().isoformat(),
      help="Forecast date in YYYY-MM-DD format",
  )
  parser.add_argument(
      "--radius",
      type=float,
      default=DEFAULT_RADIUS_METERS,
      help="Radius around center point in meters (default: 100000 = 100km)",
  )
  parser.add_argument(
      "--cleanup-only",
      action="store_true",
      help="Only delete files from previous days in tmp_downloads and exit",
  )
  parser.add_argument(
      "--json",
      action="store_true",
      help="Print structured JSON payload on stdout for the web application",
  )
  args = parser.parse_args()

  target_date = datetime.date.fromisoformat(args.date)
  today_str = target_date.isoformat()
  tmp_dir = get_tmp_downloads_dir()

  # Always delete any files from previous days in tmp_downloads/
  deleted_files = cleanup_previous_days_files(tmp_dir, today_str)

  if args.cleanup_only:
    payload = {
        "ok": True,
        "cleanupOnly": True,
        "date": today_str,
        "deletedFiles": deleted_files,
    }
    print(json.dumps(payload))
    return

  area = compute_bounding_box(args.lat, args.lon, args.radius)
  region_tag = f"{today_str}_{args.lat:.2f}_{args.lon:.2f}"
  grib_path = tmp_dir / f"glofas_forecast_{region_tag}.grib2"
  geotiff_path = tmp_dir / f"glofas_forecast_{region_tag}.tif"

  cached = False
  if geotiff_path.exists() and geotiff_path.stat().st_size > 0:
    cached = True
    print(f"Using existing GeoTIFF for today ({today_str}) from {geotiff_path} to spare download time.")
  else:
    download_glofas_grib2(grib_path=grib_path, target_date=target_date, area=area)
    convert_grib2_to_geotiff(grib_path=grib_path, geotiff_path=geotiff_path)

  leaflet_bounds, overlays = render_geotiff_bands_to_overlays(geotiff_path)

  if args.json:
    payload = {
        "ok": True,
        "cached": cached,
        "date": today_str,
        "center": [args.lat, args.lon],
        "radiusKm": round(args.radius / 1000.0, 1),
        "areaNWSE": area,
        "bounds": leaflet_bounds,
        "geotiffPath": str(geotiff_path.relative_to(tmp_dir.parent)),
        "deletedFiles": deleted_files,
        "clipMax": CLIP_MAX_DISCHARGE,
        "overlays": overlays,
    }
    print(json.dumps(payload))


if __name__ == "__main__":
  main()
