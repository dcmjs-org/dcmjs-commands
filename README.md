# dcmjs-commands

To install, clone the directory and run:

```
bun install
bun run build
bun run link:exec
```

# dcmjs commands

## dump `filename`

```
dcmjs dump <part10file>
```

# dicomwebjs commands

## dump `url`

```
# Example series retrieve/dump
dicomwebjs dump https://d33do7qe4w26qo.cloudfront.net/dicomweb/studies/1.3.6.1.4.1.14519.5.2.1.4792.2001.105216574054253895819671475627/series
# Example metadata retrieve/dump
dicomwebjs dump https://d33do7qe4w26qo.cloudfront.net/dicomweb/studies/1.3.6.1.4.1.14519.5.2.1.4792.2001.105216574054253895819671475627/series/1.3.6.1.4.1.14519.5.2.1.4792.2001.323835191362867057104216682000/metadata

# Example file retrieve
dicomwebjs dump testdata/studies/1.2.276.1.74.1.2.132733202464108492637644434464108492/series/2.16.840.1.113883.3.8467.132733202477512857637644434477512857/metadata.gz
```

## download `url`

dicomwebjs can be used to download a directory of file locations. By default it will fetch everything at and below the specified URL, plus referenced bulkdata. Bulkdata will be
placed in the `studies/<studyUID>/bulkdata` directory, with metadata references to the bulkdata using the `../../bulkdata/<path>` relative URI locations.

### Example Commands

```
dicomwebjs download https://d33do7qe4w26qo.cloudfront.net/dicomweb/studies/1.3.6.1.4.1.14519.5.2.1.4792.2001.105216574054253895819671475627 -d ~/dicomweb
```

### File Locations

Files dicomweb can be paths to JSON files. However, tree structure data must follow the Static DICOMweb format, specifically starting at `studies/` relative to the base directory, and containing some/all of the ones below.
Note that un-compressed files are acceptable as well, but will not be found on a search.

- `studies/index.json.gz` - an index in DICOMweb QIDO response format for the studies
- `studies/<studyUID>/index.json.gz` - the index entry of this study
- `studies/<studyUID>/series/index.json.gz` - the series QIDO response
- `studies/<studyUID>/series/<seriesUID>/metadata.gz` - the metadata WADO response
- `studies/<studyUID>/bulkdata/...` - bulkdata files
- `studies/<studyUID>/series/<seriesUID>/instances/<instanceUID>/frame/<frameNumber>` - compressed frame data
