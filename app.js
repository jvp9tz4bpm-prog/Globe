(() => {
  "use strict";

  const WORLD_GEOJSON_URL =
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson";
  const WORLD_BANK_BASE = "https://api.worldbank.org/v2/country/all/indicator/";
  const YEAR_WINDOW = "2015:2025";
  const INDICATORS = [
    { key: "gdp", code: "NY.GDP.MKTP.CD", label: "GDP", format: formatCurrency },
    { key: "gdppc", code: "NY.GDP.PCAP.CD", label: "GDP per capita", format: formatCurrency },
    { key: "growth", code: "NY.GDP.MKTP.KD.ZG", label: "GDP growth", format: formatPercent },
    { key: "inflation", code: "FP.CPI.TOTL.ZG", label: "Inflation", format: formatPercent },
    { key: "population", code: "SP.POP.TOTL", label: "Population", format: formatPopulation },
    { key: "unemployment", code: "SL.UEM.TOTL.ZS", label: "Unemployment", format: formatPercent }
  ];

  const state = {
    features: [],
    countries: new Map(),
    globe: null,
    selectedFeature: null,
    initialView: { lat: 18, lng: 12, altitude: 2.05 }
  };

  const $ = (id) => document.getElementById(id);

  function formatCurrency(value) {
    if (!Number.isFinite(value)) return null;
    const abs = Math.abs(value);
    if (abs >= 1e12) return "$" + (value / 1e12).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "T";
    if (abs >= 1e9) return "$" + (value / 1e9).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "B";
    if (abs >= 1e6) return "$" + (value / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "M";
    return "$" + value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  function formatPopulation(value) {
    if (!Number.isFinite(value)) return null;
    if (value >= 1e9) return (value / 1e9).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "B";
    if (value >= 1e6) return (value / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "M";
    return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  function formatPercent(value) {
    if (!Number.isFinite(value)) return null;
    return value.toLocaleString("en-US", { maximumFractionDigits: 2 }) + "%";
  }

  function showLoadError(message) {
    $("data-status").textContent = message;
    $("globe-loading").classList.add("hidden");
  }

  function getIso3(feature) {
    const p = feature.properties || {};
    const candidates = [p.ISO_A3, p.ADM0_A3, p.SOV_A3];
    for (const code of candidates) {
      if (typeof code === "string" && /^[A-Z]{3}$/.test(code) && code !== "-99") return code;
    }
    return null;
  }

  function getCountryName(feature) {
    const p = feature.properties || {};
    return p.ADMIN || p.NAME || p.name || "Unknown country";
  }

  async function fetchIndicator(indicator) {
    const url = new URL(
      WORLD_BANK_BASE + encodeURIComponent(indicator.code),
      window.location.href
    );
    // Use an absolute URL because the API is hosted separately from GitHub Pages.
    const apiUrl = "https://api.worldbank.org/v2/country/all/indicator/" +
      encodeURIComponent(indicator.code) +
      "?format=json&per_page=20000&date=" + YEAR_WINDOW;

    const response = await fetch(apiUrl);
    if (!response.ok) throw new Error(indicator.label + " request failed (" + response.status + ")");
    const payload = await response.json();
    if (!Array.isArray(payload) || !Array.isArray(payload[1])) {
      throw new Error("Unexpected response for " + indicator.label);
    }

    const latestByCountry = new Map();
    for (const item of payload[1]) {
      const code = item && item.countryiso3code;
      const value = item && item.value;
      const year = Number(item && item.date);
      if (!code || value === null || value === undefined || !Number.isFinite(Number(value))) continue;
      const previous = latestByCountry.get(code);
      if (!previous || year > previous.year) {
        latestByCountry.set(code, { value: Number(value), year });
      }
    }
    return { key: indicator.key, values: latestByCountry };
  }

  async function loadWorldData() {
    const results = await Promise.allSettled(INDICATORS.map(fetchIndicator));
    const successful = results.filter(r => r.status === "fulfilled").map(r => r.value);
    if (successful.length === 0) {
      throw new Error("The World Bank API could not be reached. Check your connection and reload.");
    }

    for (const result of successful) {
      for (const [iso3, observation] of result.values) {
        if (!state.countries.has(iso3)) state.countries.set(iso3, { iso3 });
        state.countries.get(iso3)[result.key] = observation;
      }
    }

    const failed = results.filter(r => r.status === "rejected");
    if (failed.length) {
      console.warn("Some indicator requests failed:", failed.map(r => r.reason));
    }
    return { loaded: successful.length, failed: failed.length };
  }

  async function loadBoundaries() {
    const response = await fetch(WORLD_GEOJSON_URL);
    if (!response.ok) throw new Error("Country boundaries could not be loaded (" + response.status + ")");
    const geojson = await response.json();
    if (!geojson || !Array.isArray(geojson.features)) throw new Error("Unexpected country boundary data");
    state.features = geojson.features
      .filter(f => f && f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"))
      .map(feature => {
        feature.properties = feature.properties || {};
        feature.properties.__iso3 = getIso3(feature);
        feature.properties.__countryName = getCountryName(feature);
        const country = feature.properties.__iso3 ? state.countries.get(feature.properties.__iso3) : null;
        feature.properties.__hasData = !!country && INDICATORS.some(ind => !!country[ind.key]);
        return feature;
      });
    return state.features.length;
  }

  function hasUsableData(feature) {
    return !!feature.properties.__hasData;
  }

  function polygonCapColor(feature) {
    if (state.selectedFeature && state.selectedFeature === feature) return "#9ce8d9";
    return hasUsableData(feature) ? "#2b887f" : "#4b5565";
  }

  function polygonSideColor(feature) {
    return hasUsableData(feature) ? "rgba(16, 48, 57, 0.85)" : "rgba(28, 36, 49, 0.88)";
  }

  function polygonStrokeColor(feature) {
    if (state.selectedFeature && state.selectedFeature === feature) return "#b7fff1";
    return hasUsableData(feature) ? "rgba(130, 220, 207, 0.55)" : "rgba(151, 163, 181, 0.32)";
  }

  function initGlobe() {
    if (typeof Globe !== "function") throw new Error("Globe library did not load. Check your internet connection.");
    const globe = Globe()( $("globe") )
      .width($("globe-wrap").clientWidth)
      .height($("globe-wrap").clientHeight)
      .backgroundColor("rgba(0,0,0,0)")
      .showAtmosphere(true)
      .atmosphereColor("#2a8d9a")
      .atmosphereAltitude(0.16)
      .polygonsData(state.features)
      .polygonGeoJsonGeometry(feature => feature.geometry)
      .polygonCapColor(polygonCapColor)
      .polygonSideColor(polygonSideColor)
      .polygonStrokeColor(polygonStrokeColor)
      .polygonAltitude(feature => state.selectedFeature === feature ? 0.012 : 0.002)
      .polygonLabel(feature => {
        const name = feature.properties.__countryName;
        return `<div style="font-family:DM Sans,sans-serif;background:#0d1726;color:#eef4fc;border:1px solid #33445a;border-radius:8px;padding:8px 10px;font-size:12px;"><strong>${escapeHtml(name)}</strong><br><span style="color:#9fb0c6;font-size:10px;">${hasUsableData(feature) ? "Economic data available" : "No usable data for selected indicators"}</span></div>`;
      })
      .onPolygonClick(feature => selectCountry(feature))
      .onPolygonHover(feature => {
        const canvas = $("globe").querySelector("canvas");
        if (canvas) canvas.style.cursor = feature ? "pointer" : "grab";
        if (feature !== state.selectedFeature) {
          globe.polygonCapColor(polygonCapColor);
          globe.polygonStrokeColor(polygonStrokeColor);
        }
      });

    globe.controls().autoRotate = false;
    globe.controls().enableDamping = true;
    globe.pointOfView(state.initialView, 0);
    state.globe = globe;

    const resize = () => {
      if (!state.globe) return;
      state.globe.width($("globe-wrap").clientWidth);
      state.globe.height($("globe-wrap").clientHeight);
    };
    window.addEventListener("resize", resize);
    $("zoom-in").addEventListener("click", () => zoomBy(0.78));
    $("zoom-out").addEventListener("click", () => zoomBy(1.28));
    $("reset-view").addEventListener("click", () => {
      state.globe.pointOfView(state.initialView, 700);
    });
    $("clear-selection").addEventListener("click", clearSelection);
  }

  function zoomBy(multiplier) {
    if (!state.globe) return;
    const pov = state.globe.pointOfView();
    const altitude = Math.max(0.65, Math.min(4.5, pov.altitude * multiplier));
    state.globe.pointOfView({ ...pov, altitude }, 300);
  }

  function selectCountry(feature) {
    if (!feature) return;
    state.selectedFeature = feature;
    if (state.globe) {
      state.globe.polygonCapColor(polygonCapColor);
      state.globe.polygonStrokeColor(polygonStrokeColor);
      state.globe.polygonAltitude(f => state.selectedFeature === f ? 0.012 : 0.002);
    }

    const props = feature.properties || {};
    const iso3 = props.__iso3;
    const name = props.__countryName || "Unknown country";
    const country = iso3 ? state.countries.get(iso3) : null;

    $("empty-state").classList.add("hidden");
    $("country-content").classList.remove("hidden");
    $("country-name").textContent = name;
    $("country-code").textContent = iso3 ? "ISO 3166-1 · " + iso3 : "COUNTRY CODE UNAVAILABLE";

    const availableCount = country ? INDICATORS.filter(ind => country[ind.key]).length : 0;
    const stateEl = $("country-data-state");
    if (availableCount > 0) {
      stateEl.className = "data-state has-data";
      stateEl.textContent = availableCount + " of " + INDICATORS.length + " indicators available · World Bank";
    } else {
      stateEl.className = "data-state";
      stateEl.textContent = "No usable observations found for these indicators in the selected period.";
    }

    for (const indicator of INDICATORS) {
      const observation = country && country[indicator.key];
      const valueEl = $("metric-" + indicator.key);
      const yearEl = $("year-" + indicator.key);
      if (observation) {
        valueEl.textContent = indicator.format(observation.value) || "No data available";
        valueEl.classList.toggle("unavailable", !indicator.format(observation.value));
        yearEl.textContent = "Observation year: " + observation.year;
      } else {
        valueEl.textContent = "No data available";
        valueEl.classList.add("unavailable");
        yearEl.textContent = "No observation in " + YEAR_WINDOW;
      }
    }
  }

  function clearSelection() {
    state.selectedFeature = null;
    if (state.globe) {
      state.globe.polygonCapColor(polygonCapColor);
      state.globe.polygonStrokeColor(polygonStrokeColor);
      state.globe.polygonAltitude(() => 0.002);
    }
    $("country-content").classList.add("hidden");
    $("empty-state").classList.remove("hidden");
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char]));
  }

  async function main() {
    try {
      $("data-status").textContent = "Loading country boundaries…";
      // Load the geographic dataset and macroeconomic indicators in parallel.
      const dataPromise = loadWorldData();
      const boundaryResponse = await fetch(WORLD_GEOJSON_URL);
      if (!boundaryResponse.ok) throw new Error("Country boundaries could not be loaded (" + boundaryResponse.status + ")");
      const geojson = await boundaryResponse.json();
      if (!geojson || !Array.isArray(geojson.features)) throw new Error("Unexpected country boundary data");
      state.features = geojson.features
        .filter(f => f && f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"))
        .map(feature => {
          feature.properties = feature.properties || {};
          feature.properties.__iso3 = getIso3(feature);
          feature.properties.__countryName = getCountryName(feature);
          return feature;
        });

      $("data-status").textContent = "Loading economic indicators…";
      const dataResult = await dataPromise;

      for (const feature of state.features) {
        const iso3 = feature.properties.__iso3;
        const country = iso3 ? state.countries.get(iso3) : null;
        feature.properties.__hasData = !!country && INDICATORS.some(ind => !!country[ind.key]);
      }

      initGlobe();
      $("data-status").textContent = dataResult.failed
        ? "Loaded with " + dataResult.failed + " indicator issue(s)"
        : "World Bank data loaded";
      $("globe-loading").classList.add("hidden");
    } catch (error) {
      console.error(error);
      showLoadError("Could not load all data");
      $("globe-loading").querySelector("strong").textContent = "Unable to load the globe";
      $("globe-loading").querySelector("span").textContent =
        (error && error.message ? error.message : "Please check your connection and reload.") +
        " This app needs an internet connection.";
      $("globe-loading").classList.remove("hidden");
    }
  }

  main();
})();
