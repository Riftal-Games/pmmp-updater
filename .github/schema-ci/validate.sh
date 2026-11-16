#!/bin/sh
# Upstream's check for one upgrade schema package, run from the package directory:
# no two schema files share a numeric prefix, and every schema file validates against
# the package's own JSON schema. Arguments are the schema directory, the JSON schema,
# then any options ajv needs for that schema. Every file is checked before it exits.
set -u

dir="$1"
schema="$2"
shift 2

# A missing or empty directory would pass the loops below without checking anything.
files=$(ls "$dir") || exit 1
if [ -z "$files" ]; then
  echo "No schema files in $dir"
  exit 1
fi

status=0

for file in $files; do
  prefix=$(echo "$file" | cut -d _ -f1)
  if [ "$(echo "$files" | grep -c "^$prefix")" -gt 1 ]; then
    echo "Duplicate prefix $prefix"
    status=1
  fi
done

for file in $files; do
  ajv validate "$@" -s "$schema" -d "$dir/$file" || status=1
done

exit "$status"
