Build and push image to registry:
```bash
docker buildx build --platform linux/amd64 -t dkr-reg.home.leaflex.site/on-demand-scraping:latest --push .
```

Pull image from registry:
```bash
docker pull dkr-reg.home.leaflex.site/on-demand-scraping:latest
```

The whole enchilada for quick testing:
```bash
docker stop on-demand-scraping-service && \
  docker rm on-demand-scraping-service && \
  docker pull dkr-reg.home.leaflex.site/on-demand-scraping:latest && \
  docker run -d --name on-demand-scraping-service \
  -e APP_PATH_FOR_SCRIPTS="/home/supapawa/pptr-scripts/" \
  -e APP_IS_DEBUG_ON=true \
  -e APP_PORT=3600 \
  -p 6080:3600 \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  dkr-reg.home.leaflex.site/on-demand-scraping:latest
```
