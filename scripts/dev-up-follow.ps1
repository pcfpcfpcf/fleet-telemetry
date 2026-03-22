docker compose up -d
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

docker logs fleet-adapter -f
