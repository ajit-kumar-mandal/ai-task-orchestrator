import { spawnSync } from "node:child_process";

const raw = process.env.TASK_CONTAINER_IMAGES || "";
const images = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
for (const image of images) {
  if (!/^[a-zA-Z0-9._/:+-]+@sha256:[a-f0-9]{64}$/.test(image)) {
    console.error("TASK_CONTAINER_IMAGES must contain only exact image references pinned to sha256 digests.");
    process.exit(1);
  }
}

for (const image of images) {
  console.log(`Preparing approved task image ${image.split("@")[0]}@sha256:[digest hidden]`);
  const result = spawnSync("docker", ["pull", image], { stdio: "inherit", shell: false });
  if (result.error || result.status !== 0) {
    console.error("Could not prepare an approved task image. Check registry access and the pinned digest.");
    process.exit(1);
  }
}