"use strict";

const CMR = "https://cmr.earthdata.nasa.gov";
const HARMONY = "https://harmony.earthdata.nasa.gov";
const EARTHDATA = "https://search.earthdata.nasa.gov";
const COLLECTION_ID = /^C\d+-[a-z0-9_]+$/i;
const JOB_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const boundsFields = ["west", "south", "east", "north"];
const pageSize = { collections: 9, granules: 10 };
const polygonMediaTypes = new Map([
  ["geojson", "application/geo+json"],
  ["json", "application/geo+json"],
  ["zip", "application/shapefile+zip"],
  ["shz", "application/shapefile+zip"],
  ["kml", "application/vnd.google-earth.kml+xml"],
]);

const state = {
  filters: null,
  selection: null,
  capabilities: null,
  selectedGranule: null,
  collections: { cursor: "", count: 0, request: null },
  granules: { cursor: "", count: 0, request: null },
  capabilityRequest: null,
  jobRequest: null,
  jobPage: 1,
};

const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function feedback(id, text = "", error = false) {
  $(id).textContent = text;
  $(id).dataset.error = String(error);
}

function httpsLink(href, text, className) {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const link = node("a", text, className);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  } catch {
    return null;
  }
}

function urlFor(origin, path, parameters = {}) {
  const url = new URL(path, origin);
  url.search = new URLSearchParams(parameters);
  return url;
}

function failIfAborted(signal) {
  signal?.throwIfAborted();
}

async function requestJson(url, { token, signal, headers, body, method, accept = "application/json" } = {}) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Accept", accept);
  if (token) {
    if (url.origin !== HARMONY) throw new Error("The token can only be sent to NASA Harmony.");
    requestHeaders.set("Authorization", `Bearer ${token}`);
  }
  const timeout = AbortSignal.timeout(25000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const service = url.origin === HARMONY ? "Harmony" : "CMR Search";
  let response;
  try {
    response = await fetch(url, {
      headers: requestHeaders,
      signal: requestSignal,
      credentials: "omit",
      cache: "no-store",
      method,
      body,
    });
  } catch {
    failIfAborted(signal);
    if (timeout.aborted) throw new Error(`${service} took too long to respond.`);
    throw new Error(token
      ? "Harmony could not be reached. Check your Earthdata Login token or open the Harmony Workflow UI."
      : `${service} could not be reached. Try again shortly.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("NASA rejected access. Check your Earthdata Login token and collection permissions.");
  }
  if (!response.ok) throw new Error(`${service} returned HTTP ${response.status}.`);
  if (!response.headers.get("content-type")?.includes("json")) {
    throw new Error(`${service} returned an unexpected response.`);
  }
  return { data: await response.json(), response };
}

function readFilters() {
  const inputs = boundsFields.map((field) => $(field).value);
  let bounds = null;
  if (inputs.some(Boolean)) {
    if (inputs.some((value) => !value)) throw new Error("Enter all four bounding-box coordinates.");
    const [west, south, east, north] = inputs.map(Number);
    if (![west, south, east, north].every(Number.isFinite) ||
        west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
      throw new Error("Enter a valid bounding box with west < east and south < north.");
    }
    bounds = { west, south, east, north };
  }
  const start = $("start").value;
  const end = $("end").value;
  if (start && end && start > end) throw new Error("The end date must be on or after the start date.");

  const product = $("product").value;
  const keyword = $("keyword").value.trim();
  if (product === "custom" && !keyword) throw new Error("Enter a collection keyword or short name.");
  return {
    bounds,
    start: start ? `${start}T00:00:00Z` : "",
    end: end ? `${end}T23:59:59.999Z` : "",
    product,
    keyword,
  };
}

function spatialTemporal(filters) {
  const result = {};
  if (filters.bounds) result.bounding_box = Object.values(filters.bounds).join(",");
  if (filters.start || filters.end) result.temporal = `${filters.start},${filters.end}`;
  return result;
}

function resetResults(result, list, moreButton) {
  result.request?.abort();
  result.request = null;
  result.cursor = "";
  result.count = 0;
  $(list).replaceChildren();
  $(list).setAttribute("aria-busy", "false");
  $(moreButton).hidden = true;
  $(moreButton).disabled = false;
}

function chooseCollection(entry) {
  state.selection = entry;
  state.selectedGranule = null;
  state.capabilities = null;
  state.capabilityRequest?.abort();
  state.capabilityRequest = null;
  $("check-capabilities").disabled = !entry;
  $("subset-options").hidden = true;
  $("capabilities-list").hidden = true;
  $("variables").value = "";
  $("shape").value = "";
  $("earthdata-collection").hidden = !entry;
  feedback("capabilities-status");
  feedback("submit-status");
  for (const card of $("collections").children) {
    const selected = card.dataset.id === entry?.id;
    card.classList.toggle("selected", selected);
    const button = card.querySelector("button");
    button.textContent = selected ? "Selected" : "View files";
    button.setAttribute("aria-pressed", String(selected));
  }
  resetResults(state.granules, "granule-list", "more-granules");
  $("granules").hidden = !entry;
  $("selected-collection").textContent = entry
    ? `${entry.short_name ?? entry.title} · ${entry.id}`
    : "Select a collection in the search results.";
  $("subset-filters").textContent = "";
  if (!entry) return;
  const { bounding_box, temporal } = spatialTemporal(state.filters);
  $("subset-filters").textContent = [
    bounding_box && `Bounds ${bounding_box}`,
    temporal && `Dates ${state.filters.start.slice(0, 10) || "open"} to ${state.filters.end.slice(0, 10) || "open"}`,
  ].filter(Boolean).join(" · ") || "No area or dates applied.";
  $("earthdata-collection").href = urlFor(EARTHDATA, "/search/granules", { p: entry.id });
  $("granules-title").focus({ preventScroll: true });
  $("granules").scrollIntoView({ block: "nearest" });
  void fetchCmr("granules");
}

function collectionCard(entry) {
  if (!COLLECTION_ID.test(entry.id)) return null;
  const card = node("article", "", "panel collection");
  card.dataset.id = entry.id;
  const description = entry.summary ?? "";
  const version = entry.version_id ? `v${entry.version_id}` : "";
  const button = node("button", "View files", "button button--compact");
  button.type = "button";
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => chooseCollection(entry));
  const heading = node("h3", entry.title ?? entry.dataset_id ?? entry.short_name ?? entry.id);
  button.setAttribute("aria-label", `View files for ${heading.textContent}`);
  card.append(
    node("p", [entry.short_name, version, entry.data_center].filter(Boolean).join(" · "), "collection-meta"),
    heading,
    node("p", description.length > 200 ? `${description.slice(0, 197).trimEnd()}…` : description, "description"),
    button,
  );
  return card;
}

function selectGranule(entry, button) {
  state.selectedGranule = state.selectedGranule?.id === entry.id ? null : entry;
  for (const item of $("granule-list").children) {
    const control = item.querySelector("button");
    const selected = control === button && state.selectedGranule !== null;
    control.textContent = selected ? "Selected for subset" : "Use for subset";
    control.setAttribute("aria-pressed", String(selected));
  }
  feedback("submit-status", state.selectedGranule
    ? `Subset limited to source file ${state.selectedGranule.id}.`
    : "Subset can use any matching file.");
}

function granuleRow(entry) {
  if (!/^G\d+-[a-z0-9_]+$/i.test(entry.id)) return null;
  const row = node("li");
  const name = entry.producer_granule_id ?? entry.title ?? entry.id;
  const fields = node("div");
  const size = Number(entry.granule_size);
  fields.append(
    node("p", name, "file-name"),
    node("p", [entry.time_start?.slice(0, 10), entry.id, size > 0 && `${number.format(size)} MB`].filter(Boolean).join(" · "), "file-meta"),
  );
  const actions = node("div", "", "actions");
  const link = (entry.links ?? []).find(({ href, rel, inherited }) =>
    !inherited && rel?.endsWith("/data#") && typeof href === "string" && href.startsWith("https://"));
  const download = link && httpsLink(link.href, "Original file ↗");
  if (download) actions.append(download);
  const button = node("button", "Use for subset", "button button--compact");
  button.type = "button";
  button.setAttribute("aria-pressed", "false");
  button.setAttribute("aria-label", `Use ${name} for subset`);
  button.addEventListener("click", () => selectGranule(entry, button));
  actions.append(button);
  row.append(fields, actions);
  return row;
}

async function fetchCmr(type) {
  const searchingCollections = type === "collections";
  const result = state[type];
  const status = searchingCollections ? "search-status" : "granule-status";
  const list = searchingCollections ? "collections" : "granule-list";
  const more = searchingCollections ? "more-collections" : "more-granules";
  const request = new AbortController();
  result.request?.abort();
  result.request = request;
  $(more).disabled = true;
  $(list).setAttribute("aria-busy", "true");
  feedback(status, searchingCollections ? "Searching the catalog…" : "Finding matching files…");

  const { product, keyword, version } = state.filters;
  const query = { ...spatialTemporal(state.filters), page_size: pageSize[type] };
  if (!searchingCollections) {
    query.collection_concept_id = state.selection.id;
  } else if (product === "custom") {
    query.keyword = keyword;
  } else {
    query.short_name = product;
    query.provider = product.startsWith("GEDI") ? "LPCLOUD" : "NSIDC_CPRD";
    query["sort_key[]"] = "-revision_date";
    if (version) query.version = version;
  }
  const headers = result.cursor ? { "CMR-Search-After": result.cursor } : {};
  try {
    const { data, response } = await requestJson(urlFor(CMR, `/search/${type}.json`, query), {
      headers,
      signal: request.signal,
    });
    failIfAborted(request.signal);
    const entries = data.feed?.entry;
    if (!Array.isArray(entries)) throw new Error("CMR Search returned an unexpected response.");
    const rows = entries.map(searchingCollections ? collectionCard : granuleRow).filter(Boolean);
    $(list).append(...rows);
    result.count += entries.length;
    const hits = Number(response.headers.get("CMR-Hits"));
    const nextCursor = response.headers.get("CMR-Search-After");
    $(more).hidden = !nextCursor || nextCursor === result.cursor ||
      (hits ? result.count >= hits : entries.length < pageSize[type]);
    result.cursor = nextCursor;
    const noun = searchingCollections ? "collections" : "files";
    const count = hits && hits >= result.count
      ? `${number.format(result.count)} of ${number.format(hits)}`
      : number.format(result.count);
    feedback(status, result.count ? `Showing ${count} ${noun}.` : `No ${noun} matched. Try a larger area or date range.`);
  } catch (error) {
    if (!request.signal.aborted) feedback(status, error.message, true);
  } finally {
    if (result.request === request) {
      $(more).disabled = false;
      $(list).setAttribute("aria-busy", "false");
    }
  }
}

function search(version = "") {
  try {
    state.filters = { ...readFilters(), version };
  } catch (error) {
    feedback("search-status", error.message, true);
    return;
  }
  chooseCollection(null);
  resetResults(state.collections, "collections", "more-collections");
  void fetchCmr("collections");
}

function showCapabilities(data) {
  state.capabilities = null;
  const names = [
    [data.bboxSubset, "Bounding box"],
    [data.temporalSubset, "Date range"],
    [data.variableSubset, "Variables"],
    [data.shapeSubset, "Polygon"],
  ];
  $("capabilities-list").replaceChildren(...names.filter(([enabled]) => enabled).map(([, name]) => node("li", name)));
  $("capabilities-list").hidden = $("capabilities-list").childElementCount === 0;
  $("subset-options").hidden = !data.services?.length;
  if (!data.services?.length) {
    feedback("capabilities-status", "Harmony has no processing service for this collection. You can still download original files.");
    return;
  }

  state.capabilities = data;
  const options = (data.outputFormats ?? []).map((format) => new Option(format, format));
  $("output-format").replaceChildren(new Option("Collection default", ""), ...options);
  $("format-label").hidden = !options.length;
  $("variable-label").hidden = !data.variableSubset;
  $("shape-label").hidden = !data.shapeSubset;
  const variables = (data.variables ?? []).map((variable) => {
    if (typeof variable === "string") return variable;
    const id = variable.href?.split("/").pop();
    return id ? `${variable.name} · ${id}` : variable.name;
  }).filter(Boolean);
  $("variable-details").hidden = !data.variableSubset || !variables.length;
  $("variable-list").replaceChildren(...variables.slice(0, 40).map((name) => node("li", name)));
  $("variables-help").textContent = variables.length > 40
    ? `Showing 40 of ${number.format(variables.length)} variables. See the full list in NASA’s capability response.`
    : "";
  if (variables.length > 40) {
    const link = httpsLink(urlFor(HARMONY, "/capabilities", { collectionId: data.conceptId, version: "2" }), " Full list ↗");
    if (link) $("variables-help").append(link);
  }

  const { bounds, start, end } = state.filters;
  const skipped = [
    bounds && !data.bboxSubset && "bounding box",
    (start || end) && !data.temporalSubset && "date range",
  ].filter(Boolean);
  feedback("capabilities-status", skipped.length
    ? `Harmony cannot apply the current ${skipped.join(" or ")} inside the files. Choose a matching file above to use it as the source.`
    : "Harmony can process this collection.");
}

async function checkCapabilities() {
  if (!state.selection) return;
  const request = new AbortController();
  state.capabilityRequest?.abort();
  state.capabilityRequest = request;
  $("check-capabilities").disabled = true;
  feedback("capabilities-status", "Checking the collection in Harmony…");
  try {
    const { data } = await requestJson(urlFor(HARMONY, "/capabilities", {
      collectionId: state.selection.id,
      version: "2",
    }), { signal: request.signal });
    failIfAborted(request.signal);
    showCapabilities(data);
  } catch (error) {
    if (!request.signal.aborted) feedback("capabilities-status", error.message, true);
  } finally {
    if (state.capabilityRequest === request) $("check-capabilities").disabled = false;
  }
}

function currentToken() {
  const token = $("earthdata-token").value.trim();
  if (!token) throw new Error("Enter an Earthdata Login token in the New subset panel.");
  return token;
}

function makeSubsetRequest() {
  const { bounds, start, end } = state.filters;
  const capabilities = state.capabilities;
  const shape = capabilities.shapeSubset && $("shape").files[0];
  const variables = capabilities.variableSubset ? $("variables").value.trim() : "";
  const format = $("output-format").value;
  const maxResults = $("max-results").value;
  if (!state.selectedGranule && ((bounds && !capabilities.bboxSubset && !shape) ||
      ((start || end) && !capabilities.temporalSubset))) {
    throw new Error("Choose a matching source file or change the filters before submitting.");
  }
  const coverage = variables ? "parameter_vars" : "all";
  const url = urlFor(HARMONY, `/${state.selection.id}/ogc-api-coverages/1.0.0/collections/${coverage}/coverage/rangeset`);
  const params = new URLSearchParams({ forceAsync: "true", maxResults, ignoreErrors: "false" });
  if (bounds && capabilities.bboxSubset && !shape) {
    params.append("subset", `lon(${bounds.west}:${bounds.east})`);
    params.append("subset", `lat(${bounds.south}:${bounds.north})`);
  }
  if ((start || end) && capabilities.temporalSubset) {
    const from = start ? `"${start}"` : "*";
    const to = end ? `"${end}"` : "*";
    params.append("subset", `time(${from}:${to})`);
  }
  if (variables) params.set("variable", variables.split(",").map((value) => value.trim()).filter(Boolean).join(","));
  if (format) params.set("format", format);
  if (state.selectedGranule) params.set("granuleId", state.selectedGranule.id);

  if (!shape) {
    url.search = params;
    return { url };
  }
  const extension = shape.name.split(".").pop().toLowerCase();
  const mediaType = polygonMediaTypes.get(extension);
  if (!mediaType) throw new Error("Choose a GeoJSON, KML, or zipped shapefile.");
  const body = new FormData();
  for (const [name, value] of params) body.append(name, value);
  body.append("shapefile", new Blob([shape], { type: mediaType }), shape.name);
  return { url, body, method: "POST" };
}

async function submitSubset(event) {
  event.preventDefault();
  if (!state.selection || !state.capabilities) return;
  const button = $("submit-subset");
  let sent = false;
  button.disabled = true;
  try {
    const token = currentToken();
    const { url, body, method } = makeSubsetRequest();
    feedback("submit-status", "Submitting the subset to NASA Harmony…");
    sent = true;
    // Harmony uses Accept to choose the subset file format.
    const { data } = await requestJson(url, { token, body, method, accept: "*/*" });
    if (!JOB_ID.test(data.jobID)) throw new Error("Harmony did not return a job ID.");
    state.jobRequest?.abort();
    $("job-id").value = data.jobID;
    state.jobPage = 1;
    renderJob(data);
    feedback("submit-status", `Submitted Harmony job ${data.jobID}.`);
  } catch (error) {
    feedback("submit-status", sent ? `${error.message} Check the Workflow UI before submitting again.` : error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderJob(data) {
  const status = String(data.status ?? "submitted");
  const percent = Number(data.progress);
  const progress = $("job-progress");
  progress.hidden = data.progress == null || !Number.isFinite(percent);
  progress.value = progress.hidden ? 0 : percent;
  const detail = [status.replaceAll("_", " "), data.message, data.dataExpiration && `Files expire ${data.dataExpiration}.`].filter(Boolean);
  feedback("job-status", detail.join(" · "), ["failed", "canceled"].includes(status));
  $("resume-job").hidden = status !== "paused";
  $("cancel-job").hidden = !["accepted", "running", "queued", "paused"].includes(status);
  if (JOB_ID.test(data.jobID)) $("workflow-link").href = `${HARMONY}/workflow-ui/${data.jobID}`;
  const outputs = (data.links ?? []).flatMap((link) => {
    const catalog = link.rel === "stac-catalog";
    if (!catalog && !["data", "preview"].includes(link.rel)) return [];
    const action = httpsLink(link.href, catalog ? "STAC catalog ↗" : "Download ↗");
    if (!action) return [];
    const row = node("li");
    const filename = new URL(action.href).pathname.split("/").pop();
    row.append(node("p", link.title ?? filename ?? "Harmony output", "file-name"), action);
    return [row];
  });
  $("output-list").replaceChildren(...outputs);
  $("job-output-pagination").hidden = !(data.links ?? []).some(({ rel }) => ["next", "prev", "previous"].includes(rel)) && state.jobPage === 1;
  $("previous-output").disabled = state.jobPage === 1;
  $("next-output").disabled = !(data.links ?? []).some(({ rel }) => rel === "next");
}

async function updateJob(action = "", page = 1) {
  let jobId = $("job-id").value.trim();
  if (jobId.startsWith(`${HARMONY}/jobs/`)) jobId = jobId.slice(`${HARMONY}/jobs/`.length);
  const request = new AbortController();
  state.jobRequest?.abort();
  state.jobRequest = request;
  $("check-job").disabled = true;
  $("resume-job").disabled = true;
  $("cancel-job").disabled = true;
  try {
    if (!JOB_ID.test(jobId)) throw new Error("Enter a valid Harmony job ID.");
    const token = currentToken();
    feedback("job-status", "Contacting Harmony…");
    if (action) {
      await requestJson(urlFor(HARMONY, `/jobs/${action}`), {
        token,
        signal: request.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobIDs: [jobId] }),
      });
    }
    const url = urlFor(HARMONY, `/jobs/${jobId}`, { page, limit: 25, linkType: "https" });
    const { data } = await requestJson(url, {
      token,
      signal: request.signal,
    });
    failIfAborted(request.signal);
    state.jobPage = page;
    renderJob(data);
  } catch (error) {
    if (!request.signal.aborted) feedback("job-status", error.message, true);
  } finally {
    if (state.jobRequest === request) {
      $("check-job").disabled = false;
      $("resume-job").disabled = false;
      $("cancel-job").disabled = false;
    }
  }
}

$("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  search();
});
$("more-collections").addEventListener("click", () => void fetchCmr("collections"));
$("more-granules").addEventListener("click", () => void fetchCmr("granules"));
$("product").addEventListener("change", () => {
  $("keyword-label").hidden = $("product").value !== "custom";
});
$("load-example").addEventListener("click", () => {
  $("product").value = "GEDI02_A";
  $("keyword-label").hidden = true;
  const example = { west: "-123", south: "44", east: "-122", north: "45", start: "2021-05-01", end: "2021-08-01" };
  for (const [key, value] of Object.entries(example)) $(key).value = value;
  search("002");
});
$("check-capabilities").addEventListener("click", () => void checkCapabilities());
$("clear-token").addEventListener("click", () => {
  $("earthdata-token").value = "";
  $("earthdata-token").focus();
});
$("subset-form").addEventListener("submit", submitSubset);
$("job-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void updateJob();
});
$("job-id").addEventListener("input", () => {
  $("resume-job").hidden = true;
  $("cancel-job").hidden = true;
  $("job-progress").hidden = true;
  $("job-output-pagination").hidden = true;
  $("workflow-link").href = `${HARMONY}/workflow-ui`;
  $("output-list").replaceChildren();
  feedback("job-status");
  state.jobRequest?.abort();
});
$("resume-job").addEventListener("click", () => void updateJob("resume"));
$("cancel-job").addEventListener("click", () => void updateJob("cancel"));
$("previous-output").addEventListener("click", () => void updateJob("", state.jobPage - 1));
$("next-output").addEventListener("click", () => void updateJob("", state.jobPage + 1));
