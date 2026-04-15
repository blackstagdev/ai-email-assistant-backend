#!/bin/bash

# Convert TypeScript to JavaScript by removing type annotations
convert_ts_to_js() {
    local ts_file="$1"
    local js_file="${ts_file%.ts}.js"
    
    # Basic conversion: remove type annotations, interfaces, etc.
    sed 's/: [A-Za-z<>[\]|, ]*//g' "$ts_file" | \
    sed 's/interface [A-Za-z]* {/\/\/ &/g' | \
    sed '/^import.*from.*;$/s/$//' | \
    sed "s/import {/const {/g" | \
    sed "s/} from '\(.*\)';/ } = require('\1');/g" | \
    sed "s/import \(.*\) from '\(.*\)';/const \1 = require('\2');/g" | \
    sed "s/export const/const/g" | \
    sed "s/export class/class/g" | \
    sed "s/export default/module.exports =/g" | \
    sed "s/export {/module.exports = {/g" > "$js_file"
}

# Find all TS files and convert
find /tmp/ts-source/ai-email-assistant/src -name "*.ts" -type f | while read ts_file; do
    echo "Converting $ts_file"
    relative_path="${ts_file#/tmp/ts-source/ai-email-assistant/src/}"
    js_file="/home/claude/ai-email-assistant-JS/src/$relative_path"
    js_file="${js_file%.ts}.js"
    
    mkdir -p "$(dirname "$js_file")"
    convert_ts_to_js "$ts_file"
done
