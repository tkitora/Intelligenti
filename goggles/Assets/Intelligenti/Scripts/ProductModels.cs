using System;
using UnityEngine;

namespace Intelligenti
{
    [Serializable]
    public sealed class Product
    {
        public string id;
        public string name;
        public string description;
        public string price;
        public int stock;
        public string shelfId;
        public string shelfName;
        public string zone;
        public string markerId;
        public string imageUrl;
        public ShelfOffset shelfOffset;
        public long targetVersion;
    }

    [Serializable]
    public sealed class ShelfOffset
    {
        public float x;
        public float y;
        public float z;
    }

    [Serializable]
    public sealed class Shelf
    {
        public string id;
        public string name;
        public string zone;
        public string markerId;
        public float x;
        public float y;
        public float z;
        public int productCount;
    }

    [Serializable]
    public sealed class MarkerLookup
    {
        public string markerId;
        public Shelf shelf;
        public Product[] products;
    }

    [Serializable]
    public sealed class MapPoint
    {
        public float x;
        public float y;
    }

    [Serializable]
    public sealed class NavigationStartMarker
    {
        public string markerId;
        public string label;
        public MapPoint position;
        public float rotationDegrees;
    }

    [Serializable]
    public sealed class NavigationRoute
    {
        public int schemaVersion;
        public string coordinateSystem;
        public string fromMarkerId;
        public string toShelfId;
        public float distanceMeters;
        public NavigationStartMarker startMarker;
        public MapPoint destination;
        public MapPoint[] points;
    }

    public sealed class MarkerObservation
    {
        public string markerId;
        public Shelf shelf;
        // The shopper's pose at the instant the location QR is accepted.
        // Map-marker rotation is aligned to this gaze direction, not to the
        // printed QR plane, whose outward normal points back at the shopper.
        public Vector3 scanPosition;
        public Vector3 scanForward;
    }

    [Serializable]
    public sealed class ApiError
    {
        public string error;
    }

    [Serializable]
    public sealed class ScanMessage
    {
        public string deviceId;
        public string productId;
        public string tagUid;
        public int rssi;
        public long uptimeMs;
    }
}
