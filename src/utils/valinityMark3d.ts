import {
  Box3, CanvasTexture, ExtrudeGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera,
  RepeatWrapping, Scene, Shape, ShapeUtils, SRGBColorSpace, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { GOLD_STOPS, VALINITY_FACETS } from './valinityMark';

/**
 * The spinning 3D Valinity V — ported from the landing site (valinity-landing
 * src/scripts/markets-v-three.ts + markets-v-motion.ts) so the mark, its gold and its motion match
 * the website exactly. Loaded with a dynamic import, so Three.js never delays the first frame.
 */

const FULL_TURN = Math.PI * 2;
const START_ANGLE = -0.3;
const BASE_ROTATION_MS = 36_000;
const BURST_CYCLE_MS = 4_000;
const BURST_DELAY_MS = 2_000;
const BURST_DURATION_MS = 2_000;
const BURST_TURNS = 2;

const smootherstep = (p: number) => {
  const c = Math.min(1, Math.max(0, p));
  return c * c * c * (c * (c * 6 - 15) + 10);
};

/** The website's timeline: a slow 36-second turn plus two eased turns in the last 2s of every 4s. */
export function valinityMarkAngle(elapsedMs: number): number {
  const t = Math.max(0, elapsedMs);
  const cycles = Math.floor(t / BURST_CYCLE_MS);
  const burst = smootherstep((t - cycles * BURST_CYCLE_MS - BURST_DELAY_MS) / BURST_DURATION_MS);
  return START_ANGLE + (t / BASE_ROTATION_MS + (cycles + burst) * BURST_TURNS) * FULL_TURN;
}

export type ValinityMarkScene = { render: (elapsedMs: number) => void; dispose: () => void };

export function createValinityMarkScene(canvas: HTMLCanvasElement): ValinityMarkScene {
  const renderer = new WebGLRenderer({
    canvas, alpha: true, antialias: true, premultipliedAlpha: true, failIfMajorPerformanceCaveat: false,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  const camera = new PerspectiveCamera(28, 1, 0.1, 100);
  camera.position.set(0, 0.02, 5.2);
  camera.lookAt(0, 0, 0);

  const gradientCanvas = document.createElement('canvas');
  gradientCanvas.width = 512;
  gradientCanvas.height = 2;
  const ctx = gradientCanvas.getContext('2d');
  if (!ctx) throw new Error('Unable to create the Valinity gold texture.');
  const gradient = ctx.createLinearGradient(0, 0, gradientCanvas.width, 0);
  GOLD_STOPS.forEach((color, i) => gradient.addColorStop(i / (GOLD_STOPS.length - 1), color));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, gradientCanvas.width, gradientCanvas.height);

  const goldTexture = new CanvasTexture(gradientCanvas);
  goldTexture.colorSpace = SRGBColorSpace;
  goldTexture.wrapS = RepeatWrapping;
  goldTexture.repeat.set(0.5 / 1.88, 1);
  goldTexture.offset.set(0.25, 0);

  const faceMaterial = new MeshBasicMaterial({ color: 0xffffff, map: goldTexture, toneMapped: false });
  const sideMaterial = new MeshBasicMaterial({ color: 0xb48643 });

  const shapes = VALINITY_FACETS.map((polygon) => {
    const points = polygon.map(([x, y]) => new Vector2((x - 50) / 50, (50 - y) / 50));
    if (!ShapeUtils.isClockWise(points)) points.reverse();
    const shape = new Shape();
    points.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, p.y) : shape.lineTo(p.x, p.y)));
    shape.closePath();
    return shape;
  });

  const depth = 0.093;
  const geometry = new ExtrudeGeometry(shapes, { depth, steps: 1, bevelEnabled: false });
  geometry.translate(0, 0, -depth / 2);

  const pivot = new Group();
  const mark = new Group();
  mark.add(new Mesh(geometry, [faceMaterial, sideMaterial]));
  mark.position.sub(new Box3().setFromObject(mark).getCenter(new Vector3()));
  const markScale = 1.27;
  mark.scale.setScalar(markScale);
  pivot.add(mark);
  scene.add(pivot);

  let w = 0;
  let h = 0;
  const resize = () => {
    const nw = Math.max(1, Math.round(canvas.clientWidth));
    const nh = Math.max(1, Math.round(canvas.clientHeight));
    if (nw === w && nh === h) return;
    w = nw;
    h = nh;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
  observer?.observe(canvas);

  const render = (elapsedMs: number) => {
    goldTexture.offset.x = 0.25 + (1 - Math.cos((elapsedMs / 6000) * FULL_TURN)) * 0.25;
    const angle = ((valinityMarkAngle(elapsedMs) % FULL_TURN) + FULL_TURN) % FULL_TURN;
    // Near the side view, draw the separated facets together so the edge reads as one blade.
    const edge = Math.exp(-Math.pow(Math.abs(Math.cos(angle)) / 0.18, 2));
    mark.scale.set(markScale * (1 - edge * 0.72), markScale, markScale);
    pivot.rotation.set(-0.075, angle, 0);
    renderer.render(scene, camera);
  };

  const dispose = () => {
    observer?.disconnect();
    geometry.dispose();
    faceMaterial.dispose();
    sideMaterial.dispose();
    goldTexture.dispose();
    renderer.dispose();
  };

  return { render, dispose };
}
