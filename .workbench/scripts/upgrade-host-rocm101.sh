#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
installer="$project_root/workspace/data/runtime/rocm101/amdgpu-install_31.60.316000-1_all.deb"
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || { echo '该安装器针对 Ubuntu 24.04，系统版本不匹配。' >&2; exit 1; }
[[ -f "$installer" ]] || { echo '缺少已下载的官方驱动安装器。' >&2; exit 1; }
printf '%s  %s\n' '0e10319193291140ce86b8b663b0d879171cee50483e1a949c3514284580bbcc' "$installer" | sha256sum -c -
if docker ps --format '{{.Names}}' | grep -Eq '^paiton-|^pation-'; then
  echo '请先停止项目 GPU 推理服务再更新宿主驱动。' >&2
  exit 1
fi
echo '安装 AMD 31.60 驱动、ROCm 10.1 和桌面图形组件；不会自动重启。'
sudo -v
sudo apt-get update
sudo apt-get install -y "linux-headers-$(uname -r)" dkms "$installer"
sudo amdgpu-install -y --usecase=rocm,graphics --gfxversion=auto
installed_rocm="$(dpkg-query -W -f='${Version}' amdrocm)"
[[ "$installed_rocm" == 10.1.0-* ]] || { echo "ROCm 版本不符合预期：$installed_rocm" >&2; exit 1; }
dkms status amdgpu
echo '安装完成。保存工作后手动重启，再告知我继续验证图像与 LLM。'
