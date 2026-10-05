sudo podman pull ghcr.io/thecookies/browserisolation:latest
sudo podman rm -f browser-isolation
sudo podman run -d \
  --name browser-isolation \
  --restart=always \
  --network=host \
  --security-opt label=disable \
  -v /etc/browser-isolation:/config:Z \
  -v rbi-data:/data:Z \
  -v /run/podman/podman.sock:/var/run/docker.sock \
  -e DOCKER_SOCKET=/var/run/docker.sock \
  ghcr.io/thecookies/browserisolation:latest
