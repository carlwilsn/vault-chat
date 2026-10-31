# Historical RED fixture: exact push-step run block from ship.yml at
# 4a952dd5cd42cb4eeb462b702dcc9bca086c6612. NEVER run against a real remote.
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "v${{ steps.bump.outputs.version }} [skip ci]"
pushed=0
for attempt in 1 2 3; do
  if git pull --rebase origin main && git push origin HEAD:main; then pushed=1; break; fi
  echo "push attempt $attempt failed — retrying"
  sleep 2
done
[ "$pushed" = 1 ] || { echo "could not push the version bump"; exit 1; }
# Every build job checks out exactly this commit (not `main`, which
# may have moved on by the time a queued job starts).
echo "sha=$(git rev-parse HEAD)" >> $GITHUB_OUTPUT
