/*
 * Research Institutions Map
 * ---------------------------------------------------
 * 1. Fetches MAP_DATA.csv (semicolon-delimited, UTF-8).
 * 2. Parses it with PapaParse.
 * 3. Builds two GeoJSON layers:
 *      - institutions: one point per institution with valid coordinates
 *      - countries:    one big point per country (paper-weighted average
 *                      position of its institutions)
 * 4. Renders them on a MapLibre GL map using a free Esri raster style
 *    (no API key required).
 * 5. Zoomed OUT: only the country nodes are shown.
 *    Zoomed IN (past COUNTRY_TO_INSTITUTION_ZOOM): the country nodes
 *    disappear and the individual institutions appear.
 * 6. Node radius is scaled by sqrt(papers) so a few very large
 *    nodes don't drown out everything else.
 * 7. Clicking a node shows a popup:
 *      - institution node: institution / country / papers
 *      - country node:     country name / papers / top 3 institutes
 */

const CSV_PATH = "MAP_DATA.csv";
const CSV_DELIMITER = ";";

// Radius range (in pixels) for individual institution circles.
const MIN_RADIUS = 3;
const MAX_RADIUS = 24;

// Radius range (in pixels) for the big merged country circles.
const COUNTRY_MIN_RADIUS = 8;
const COUNTRY_MAX_RADIUS = 50;

// CHANGE THIS to control when countries split into institutions.
// Below this zoom level you see countries; at or above it you see institutions.
// (Bigger number = you have to zoom in further before they split.)
const COUNTRY_TO_INSTITUTION_ZOOM = 4;

// How many institutes to list in a country popup.
const TOP_INSTITUTES_COUNT = 3;

const statusBox = document.getElementById("status");

function showStatus(message, isError = false) {
  statusBox.hidden = false;
  statusBox.textContent = message;
  statusBox.style.borderColor = isError ? "#000" : "#000";
}

function hideStatus() {
  statusBox.hidden = true;
}

/**
 * Free, no-API-key base map style: Esri's classic "Light Gray Canvas" raster
 * tile service (services.arcgisonline.com). This is a legacy, long-standing
 * public REST tile service — distinct from Esri's newer key-gated basemap
 * APIs — and has historically not required any account, token, or key for
 * this kind of usage. It renders a minimal light-gray map showing only
 * country/region borders, water, and streets — no building outlines,
 * land-use coloring, or text labels.
 *
 * A CSS grayscale filter (see style.css) is applied on top as a safety net
 * to guarantee a fully black-and-white look regardless of subtle tinting.
 *
 * Note: this is a third-party free service governed by Esri's terms of use.
 * If it's ever unavailable or terms change, the OSM raw tile fallback used
 * earlier can be swapped back in (see the commented block below).
 */
const OSM_STYLE = {
  version: 8,
  sources: {
    "esri-light-gray": {
      type: "raster",
      tiles: [
        "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 16,
      attribution:
        "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors, and the GIS community",
    },
  },
  layers: [
    {
      id: "base-tiles",
      type: "raster",
      source: "esri-light-gray",
      minzoom: 0,
      maxzoom: 19,
    },
  ],
};

/* --- Fallback option (raw OpenStreetMap raster tiles), kept for reference:
const OSM_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "&copy; OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm-tiles", type: "raster", source: "osm" }],
};
--- */

const map = new maplibregl.Map({
  container: "map",
  style: OSM_STYLE,
  center: [10, 30],
  zoom: 1.5,
  renderWorldCopies: false, // prevents the map repeating sideways when panned/zoomed out
});

map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(
  new maplibregl.AttributionControl({ compact: true }),
  "bottom-right"
);

/**
 * Turns a raw "papers" count into a circle radius (in px) using a
 * square-root scale. Square-root (rather than linear) keeps a single
 * huge outlier from making every other node invisible, because circle
 * *area* then scales roughly linearly with paper count.
 * minRadius / maxRadius let us reuse this for both institutions and countries.
 */
function papersToRadius(papers, minPapers, maxPapers, minRadius = MIN_RADIUS, maxRadius = MAX_RADIUS) {
  if (maxPapers === minPapers) return (minRadius + maxRadius) / 2;

  const sqrtVal = Math.sqrt(papers);
  const sqrtMin = Math.sqrt(minPapers);
  const sqrtMax = Math.sqrt(maxPapers);

  const t = (sqrtVal - sqrtMin) / (sqrtMax - sqrtMin); // 0..1
  return minRadius + t * (maxRadius - minRadius);
}

/**
 * Cleans the raw CSV rows. Keeps every row that has a paper count
 * (so country totals are complete), and marks whether it has usable
 * coordinates (lat/lon are null when missing).
 */
function parseRows(rows) {
  const parsed = [];

  for (const row of rows) {
    const papers = parseInt(row.papers, 10);
    if (!Number.isFinite(papers)) continue;

    const lat = parseFloat(row.latitude);
    const lon = parseFloat(row.longitude);
    const hasCoords =
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180;

    parsed.push({
      institution: row.institution,
      country: (row.country || "").trim(),
      papers,
      lat: hasCoords ? lat : null,
      lon: hasCoords ? lon : null,
      hasCoords,
    });
  }

  return parsed;
}

/**
 * Builds the institution points (only institutions with valid coordinates).
 */
function buildInstitutionsGeoJSON(parsedRows) {
  const withCoords = parsedRows.filter((r) => r.hasCoords);

  const paperCounts = withCoords.map((r) => r.papers);
  const minPapers = Math.min(...paperCounts);
  const maxPapers = Math.max(...paperCounts);

  const features = withCoords.map((row) => ({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [row.lon, row.lat], // GeoJSON is [lng, lat]
    },
    properties: {
      institution: row.institution,
      country: row.country,
      papers: row.papers,
      radius: papersToRadius(row.papers, minPapers, maxPapers),
    },
  }));

  return { type: "FeatureCollection", features };
}

/**
 * Turns a 2-letter country code (e.g. "NL") into a readable name
 * ("Netherlands") using the browser's built-in region names.
 * Falls back to the code itself if the browser doesn't know it.
 */
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function countryName(code) {
  try {
    return regionNames.of(code) || code;
  } catch (err) {
    return code;
  }
}

/**
 * Groups all rows by country and works out, for each country:
 *   - total paper count
 *   - top institutes by paper count
 *   - a map position (paper-weighted average of its institutions' coordinates)
 * Countries where no institution has coordinates cannot be placed and are skipped.
 */
function groupByCountry(parsedRows) {
  const groups = new Map();

  for (const row of parsedRows) {
    if (!row.country) continue;
    if (!groups.has(row.country)) groups.set(row.country, []);
    groups.get(row.country).push(row);
  }

  const countries = [];
  for (const [code, rows] of groups) {
    const placed = rows.filter((r) => r.hasCoords);
    if (placed.length === 0) continue;

    const totalPapers = rows.reduce((sum, r) => sum + r.papers, 0);
    const placedPapers = placed.reduce((sum, r) => sum + r.papers, 0);

    const lon = placed.reduce((sum, r) => sum + r.lon * r.papers, 0) / placedPapers;
    const lat = placed.reduce((sum, r) => sum + r.lat * r.papers, 0) / placedPapers;

    const topInstitutes = [...rows]
      .sort((a, b) => b.papers - a.papers)
      .slice(0, TOP_INSTITUTES_COUNT)
      .map((r) => ({ institution: r.institution, papers: r.papers }));

    countries.push({ code, name: countryName(code), totalPapers, lon, lat, topInstitutes });
  }

  return countries;
}

/**
 * Builds the big merged country points.
 */
function buildCountriesGeoJSON(parsedRows) {
  const countries = groupByCountry(parsedRows);

  const totals = countries.map((c) => c.totalPapers);
  const minPapers = Math.min(...totals);
  const maxPapers = Math.max(...totals);

  const features = countries.map((c) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [c.lon, c.lat] },
    properties: {
      country: c.name,
      papers: c.totalPapers,
      // MapLibre flattens lists inside properties, so store the top
      // institutes as text and turn it back into a list on click.
      topInstitutes: JSON.stringify(c.topInstitutes),
      radius: papersToRadius(c.totalPapers, minPapers, maxPapers, COUNTRY_MIN_RADIUS, COUNTRY_MAX_RADIUS),
    },
  }));

  return { type: "FeatureCollection", features };
}

/**
 * Shared circle styling. Big circles are drawn first so small ones
 * are never hidden underneath them.
 */
function circleLayer(id, source, zoomRange) {
  return {
    id,
    type: "circle",
    source,
    ...zoomRange,
    layout: {
      "circle-sort-key": ["-", ["get", "papers"]],
    },
    paint: {
      "circle-radius": ["get", "radius"],
      "circle-color": "#000000",
      "circle-opacity": 0.5,
      "circle-stroke-width": 1,
      "circle-stroke-color": "#000000",
      "circle-stroke-opacity": 0.9,
    },
  };
}

/**
 * Shows a popup at the clicked node.
 */
function showPopup(e, html) {
  const feature = e.features[0];
  const coords = feature.geometry.coordinates.slice();

  // If the map is zoomed/panned such that the point is duplicated
  // across the antimeridian, adjust the popup to the correct copy.
  while (Math.abs(e.lngLat.lng - coords[0]) > 180) {
    coords[0] += e.lngLat.lng > coords[0] ? 360 : -360;
  }

  new maplibregl.Popup({ closeButton: true, maxWidth: "280px" })
    .setLngLat(coords)
    .setHTML(html)
    .addTo(map);
}

function institutionPopupHtml({ institution, country, papers }) {
  return `
    <div class="popup-institution">${escapeHtml(institution)}</div>
    <div class="popup-row"><span class="label">Country:</span> ${escapeHtml(country)}</div>
    <div class="popup-row"><span class="label">Papers:</span> ${papers}</div>
  `;
}

function countryPopupHtml({ country, papers, topInstitutes }) {
  const top = JSON.parse(topInstitutes);
  const items = top
    .map((t) => `<li>${escapeHtml(t.institution)} <span class="label">(${t.papers})</span></li>`)
    .join("");

  return `
    <div class="popup-institution">${escapeHtml(country)}</div>
    <div class="popup-row"><span class="label">Papers:</span> ${papers}</div>
    <div class="popup-row"><span class="label">Top ${top.length} institutes:</span></div>
    <ol class="popup-list">${items}</ol>
  `;
}

/**
 * Makes a layer clickable: pointer cursor on hover, popup on click.
 */
function makeClickable(layerId, buildHtml) {
  map.on("mouseenter", layerId, () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", layerId, () => {
    map.getCanvas().style.cursor = "";
  });
  map.on("click", layerId, (e) => {
    showPopup(e, buildHtml(e.features[0].properties));
  });
}

/**
 * Adds both layers. The country layer only shows BELOW the switch zoom,
 * the institution layer only AT/ABOVE it.
 */
function addLayers(institutionsGeoJSON, countriesGeoJSON) {
  map.addSource("countries", { type: "geojson", data: countriesGeoJSON });
  map.addSource("institutions", { type: "geojson", data: institutionsGeoJSON });

  map.addLayer(
    circleLayer("countries-circles", "countries", { maxzoom: COUNTRY_TO_INSTITUTION_ZOOM })
  );
  map.addLayer(
    circleLayer("institutions-circles", "institutions", { minzoom: COUNTRY_TO_INSTITUTION_ZOOM })
  );

  makeClickable("countries-circles", countryPopupHtml);
  makeClickable("institutions-circles", institutionPopupHtml);
}

// Minimal HTML-escaping so institution/country names can't break the popup markup.
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function loadData() {
  showStatus("Loading institution data…");

  fetch(CSV_PATH)
    .then((response) => {
      if (!response.ok) {
        throw new Error(
          `Could not fetch ${CSV_PATH} (HTTP ${response.status}). ` +
            `Make sure the file sits next to index.html and you're viewing this ` +
            `over http/https (not double-clicking the file), e.g. via a local server ` +
            `or GitHub Pages.`
        );
      }
      return response.text();
    })
    .then((csvText) => {
      const parsed = Papa.parse(csvText, {
        header: true,
        delimiter: CSV_DELIMITER,
        skipEmptyLines: true,
        transformHeader: (h) => h.trim(),
      });

      if (parsed.errors && parsed.errors.length > 0) {
        console.warn("CSV parse warnings:", parsed.errors);
      }

      const parsedRows = parseRows(parsed.data);
      const institutionsGeoJSON = buildInstitutionsGeoJSON(parsedRows);
      const countriesGeoJSON = buildCountriesGeoJSON(parsedRows);

      const totalCount = parsed.data.length;
      const skippedRows = parsedRows.filter((r) => !r.hasCoords);
      const skippedCount = totalCount - institutionsGeoJSON.features.length;

      if (skippedRows.length > 0) {
        console.warn(
          `${skippedRows.length} institution(s) have no coordinates (not drawn zoomed in, but still counted in country totals):`,
          skippedRows.map((r) => r.institution)
        );
      }

      if (institutionsGeoJSON.features.length === 0) {
        showStatus(
          "No institutions with valid coordinates were found in the CSV.",
          true
        );
        return;
      }

      const addLayersOnce = () => addLayers(institutionsGeoJSON, countriesGeoJSON);
      if (map.isStyleLoaded()) {
        addLayersOnce();
      } else {
        map.once("load", addLayersOnce);
      }

      if (skippedCount > 0) {
        showStatus(
          `Showing ${totalCount - skippedCount} of ${totalCount} institutions ` +
            `(${skippedCount} not drawn when zoomed in — missing coordinates; they still count in country totals). See browser console for the list.`
        );
      } else {
        hideStatus();
      }
    })
    .catch((err) => {
      console.error(err);
      showStatus(err.message, true);
    });
}

loadData();
