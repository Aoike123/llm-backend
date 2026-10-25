#!/usr/bin/env bash
set -euo pipefail
if ((EUID == 0)); then
  echo '请以普通用户运行此脚本，脚本会在需要时调用 sudo。' >&2
  exit 1
fi
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 python3-venv curl git
sudo systemctl enable --now docker
groups_to_add=docker
for gpu_group in render video; do
  if getent group "$gpu_group" >/dev/null; then groups_to_add+=",$gpu_group"; fi
done
sudo usermod -aG "$groups_to_add" "$(id -un)"
echo '安装完成。请注销并重新登录，以生效 docker/render/video 组权限。'
echo '重新登录后在项目目录运行：./lab doctor'
