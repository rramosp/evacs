#!/usr/bin/env python3
"""
Server-side Google Earth Engine script to compute Sentinel-1 SAR Ground Range Detected
median false-color composite (COPERNICUS/S1_GRD) with bands VV, VH, and VV/VH
for a Point of Interest (POI) and date range derived from the user's selected aggregation period.
"""
import sys
import json
import ee


def main():
    lng = 4.3517
    lat = 50.8503
    start_date = '2026-08-20'
    end_date = '2026-09-20'

    if len(sys.argv) >= 3:
        try:
            lng = float(sys.argv[1])
            lat = float(sys.argv[2])
        except ValueError:
            pass

    if len(sys.argv) >= 5:
        start_date = sys.argv[3]
        end_date = sys.argv[4]

    ee.Authenticate()
    ee.Initialize(project='geo-stars')
    poi = ee.Geometry.Point([lng, lat])

    # Load the Sentinel-1 Ground Range Detected collection and apply filters
    s1_collection = (
        ee.ImageCollection('COPERNICUS/S1_GRD')
        .filterBounds(poi)
        .filterDate(start_date, end_date)
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
        .filter(ee.Filter.eq('instrumentMode', 'IW'))
    )

    image_count = s1_collection.size().getInfo()

    # Reduce the collection to a single image using the median value per pixel
    median_image = s1_collection.median()

    # Create false color composite with bands VV, VH, and VV/VH
    vv = median_image.select('VV')
    vh = median_image.select('VH')
    vv_vh = vv.divide(vh).rename('VV/VH')
    composite_image = median_image.addBands(vv_vh)

    vis_params = {
        'bands': ['VV', 'VH', 'VV/VH'],
        'min': [-25, -30, 0],
        'max': [0, -5, 1],
    }

    map_id_dict = composite_image.getMapId(vis_params)

    result = {
        'ok': True,
        'tileUrl': map_id_dict['tile_fetcher'].url_format,
        'imageCount': image_count,
        'poi': [lat, lng],
        'visParams': vis_params,
        'collection': 'COPERNICUS/S1_GRD',
        'dateRange': [start_date, end_date],
    }
    print(json.dumps(result))


if __name__ == '__main__':
    main()
