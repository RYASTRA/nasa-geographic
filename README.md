# NASA Geographic

[Open NASA Geographic](https://ryastra.github.io/nasa-geographic/) to find NASA
LiDAR observations and download subsets for your study area. The site is part of
the independent [RYASTRA NASA data fleet](https://observatory.ryastra.org/).

1. Choose an Earthdata collection such as GEDI or ICESat-2, then enter a bounding box and dates.
2. Search NASA's Common Metadata Repository (CMR) for matching granules. Each granule represents an individual data file.
3. Check the collection's Harmony capabilities. For a supported collection, sign in with [NASA Earthdata Login](https://urs.earthdata.nasa.gov/) and use a personal bearer token to submit a subset.
4. Check the job status and open the output links when the job finishes.

Use **Try an Oregon example** to load a GEDI L2A search with sample coordinates
and dates. Choose a result to inspect matching files and check which options
Harmony offers for that collection.

CMR discovery works without a token for public metadata. The browser sends the
Earthdata token directly to NASA Harmony and keeps it only in the current page.
GitHub Pages serves the static files. NASA runs the processing jobs and hosts the
outputs. Available filters and output formats depend on the collection.

For use from an MCP client, see [NASA-MCP](https://github.com/RYASTRA/nasa-mcp#earthdata-and-lidar).

## Development

Run `python3 -m http.server 8000` in the repository and open
`http://localhost:8000/`. GitHub Actions deploys changes to the site from `main`.

## Sources

- [CMR Search API](https://cmr.earthdata.nasa.gov/search/site/docs/search/api.html)
- [Harmony API](https://harmony.earthdata.nasa.gov/docs)
- [NASA GEDI data resources](https://github.com/nasa/GEDI-Data-Resources)
- [NSIDC ICESat-2 subsetting services](https://nsidc.org/data/user-resources/help-center/what-subsetting-and-reformatting-services-are-available-icesat-2-data)
