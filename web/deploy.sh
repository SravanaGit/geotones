#!/bin/zsh
# Builds the web app and publishes it to the gh-pages branch, which GitHub Pages serves.
set -euo pipefail
cd ${0:A:h}
remote=$(git -C .. remote get-url origin)
npm run build
cd dist
touch .nojekyll
git init -q -b gh-pages
git add -A
git commit -q -m "Deploy $(git -C ../.. rev-parse --short HEAD)"
git push -q -f "$remote" gh-pages
rm -rf .git
echo "Published. GitHub Pages updates within a minute or two."
