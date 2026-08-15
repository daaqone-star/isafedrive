/* iSafedrive — Leaflet helpers */
(function (global) {
  const L = global.L;

  const OSM = {
    tiles: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    detour: null,
  };

  // Retina-friendly 2x tiles, falls back automatically to 1x.
  const TILES_2X = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}@2x.png";

  function createMap(el, center, zoom) {
    const map = L.map(el, { zoomControl: false, attributionControl: true }).setView(center || [6.5244, 3.3792], zoom || 13);
    L.tileLayer(OSM.tiles, { maxZoom: 19, attribution: OSM.attr }).addTo(map);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    return map;
  }

  function divIcon(html, cls) {
    return L.divIcon({ html, className: cls || "", iconSize: [34, 34], iconAnchor: [17, 17] });
  }

  function driverIcon(status) {
    const color = status === "busy" ? "#e0a800" : status === "offline" ? "#9aa1a9" : "#1a7dff";
    const dot = status === "offline" ? "🚗" : status === "busy" ? "🚗" : "🚙";
    return divIcon(
      `<div class="drv-marker"><div class="ring" style="background:${color}22"><div class="car-ico" style="background:${color}">${dot}</div></div></div>`
    );
  }

  function passengerIcon() {
    return divIcon(`<div class="pax-marker"><span>🧍</span></div>`);
  }

  function dropIcon(label) {
    return divIcon(`<div class="drop-marker">${label}</div>`);
  }

  function polylines(map, points, color) {
    const lines = [];
    for (let i = 1; i < points.length; i++) {
      const seg = L.polyline([points[i - 1], points[i]], {
        color: color || "#1a7dff", weight: 4, opacity: 0.9, dashArray: "1 8", lineCap: "round",
      }).addTo(map);
      lines.push(seg);
    }
    return lines;
  }

  function clearLayer(map) {
    if (map._clear) return map._clear();
    map.eachLayer((layer) => {
      if (layer instanceof L.Marker || layer instanceof L.Polyline) map.removeLayer(layer);
    });
    return [];
  }

  function fitAll(map, points) {
    if (!points.length) return;
    const b = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
    map.fitBounds(b, { padding: [40, 40], maxZoom: 15 });
  }

  global.MapKit = {
    OSM, createMap, divIcon, driverIcon, passengerIcon, dropIcon, polylines, clearLayer, fitAll,
  };
})(window);
