#!/bin/sh
set -eu
cd "$(dirname "$0")"
git status --short
node --input-type=module -e '
import { readFileSync } from "node:fs";
const { features } = JSON.parse(readFileSync("feature_list.json", "utf8"));
console.log(`${features.filter(f => f.passes).length}/${features.length} verified`);
for (const feature of features.filter(f => !f.passes)) {
  console.log(`${feature.id}: ${feature.description}`);
}'
