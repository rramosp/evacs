#!/usr/bin/env python3
"""
Server-side Google Earth Engine script to compute Sentinel-2 Surface Reflectance
median composite (COPERNICUS/S2_SR_HARMONIZED) for a Point of Interest (POI)
and date range derived from the user's selected aggregation period.
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

    # 3. Load the Sentinel-2 Surface Reflectance collection and apply filters
    s2_collection = (
        ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(poi)                              # Filter by location
        .filterDate(start_date, end_date)               # Filter by date range derived from aggregation period
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10)) # Keep images with < 10% clouds
    )

    image_count = s2_collection.size().getInfo()

    # If 0 scenes have <10% clouds in a short window, fall back to available scenes in the exact same date window
    if image_count == 0:
        s2_collection = (
            ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
            .filterBounds(poi)
            .filterDate(start_date, end_date)
        )
        image_count = s2_collection.size().getInfo()

    # 4. Reduce the collection to a single image using the median value per pixel
    median_image = s2_collection.median()

    # 5. Define visualization parameters for True Color (Red, Green, Blue bands)
    vis_params = {
        'bands': ['B4', 'B3', 'B2'], # B4=Red, B3=Green, B2=Blue
        'min': 0,
        'max': 3000,
        'gamma': 1.4
    }

    map_id_dict = median_image.getMapId(vis_params)

    result = {
        'ok': True,
        'tileUrl': map_id_dict['tile_fetcher'].url_format,
        'imageCount': image_count,
        'poi': [lat, lng],
        'visParams': vis_params,
        'collection': 'COPERNICUS/S2_SR_HARMONIZED',
        'dateRange': [start_date, end_date],
    }
    print(json.dumps(result))


if __name__ == '__main__':
    main()
