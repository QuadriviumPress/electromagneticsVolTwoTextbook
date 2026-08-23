import path from 'node:path';

// The pristine VT Publishing source distribution. Nothing in the build may write
// into this directory; it is read-only ground truth.
export const SRC_ROOT = 'oem-v2_distro-FINAL';

export function srcRoot(root) {
  return path.join(root, SRC_ROOT);
}

export function bookFile(root) {
  return path.join(srcRoot(root), 'orbd.tex');
}

export function modulesDir(root) {
  return path.join(srcRoot(root), 'modules');
}

export function generatedFiguresDir(root) {
  return path.join(root, 'generated', 'figures');
}
