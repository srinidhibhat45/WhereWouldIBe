#!/usr/bin/env bash
#
# fetch-raw.sh — download the open datasets that data/ is built from.
#
#   ./tools/fetch-raw.sh [outdir]      # default outdir: tools/raw
#   node tools/build-data.mjs [outdir] # then rebuild data/
#
# Everything here is public domain or CC BY. Nothing is committed to the repo:
# the raw files are ~25 MB, and the optional English-names dump is ~800 MB
# uncompressed, while the built data/ is under 1.5 MB.

set -euo pipefail

OUT="${1:-$(cd "$(dirname "$0")" && pwd)/raw}"
mkdir -p "$OUT"
cd "$OUT"

get() {
  if [ -s "$2" ]; then
    echo "  have  $2"
  else
    echo "  get   $2"
    curl -fsSL --retry 3 -o "$2" "$1"
  fi
}

echo "Plate model — Bird (2003) PB2002, via fraxen/tectonicplates (CC BY-SA)"
get https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_plates.json PB2002_plates.json

echo "Coastlines and borders — Natural Earth (public domain)"
get https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson ne_50m_land.geojson
get https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson ne_110m_countries.geojson

echo "Places — GeoNames (CC BY 4.0)"
get https://download.geonames.org/export/dump/cities15000.zip cities15000.zip
[ -s cities15000.txt ] || unzip -oq cities15000.zip
get https://download.geonames.org/export/dump/admin1CodesASCII.txt admin1CodesASCII.txt
get https://download.geonames.org/export/dump/countryInfo.txt countryInfo.txt

# Optional. Without it the build falls back to guessing aliases from the
# alternatenames column of cities15000, which handles Bombay and Peking but
# misses Cologne (Köln) and Seville (Sevilla). ~100 MB zipped.
if [ "${WITH_ENGLISH_NAMES:-0}" = "1" ]; then
  echo "English exonyms — GeoNames alternateNamesV2 (large, optional)"
  get https://download.geonames.org/export/dump/alternateNamesV2.zip alternateNamesV2.zip
  [ -s alternateNamesV2.txt ] || unzip -oq alternateNamesV2.zip alternateNamesV2.txt
else
  echo "Skipping alternateNamesV2 (set WITH_ENGLISH_NAMES=1 for better search)"
fi

echo
echo "Done. Raw data in $OUT"
echo "Next:  node tools/build-data.mjs \"$OUT\"  &&  node tools/verify.mjs"
