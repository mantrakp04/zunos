import { cn } from "@zunos/ui/lib/utils";
import { useEffect, useRef } from "react";
import {
  ACESFilmicToneMapping,
  Box3,
  DirectionalLight,
  HemisphereLight,
  type Material,
  Mesh,
  MeshPhysicalMaterial,
  type Object3D,
  PMREMGenerator,
  PerspectiveCamera,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { type GLTF, GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

import { ZUNOS_GLB_BASE64 } from "./assets/mascot/zunos-glb";

// The 3D listening bean (assets/mascot: Blender source, GLB rig and morph targets), animated as an
// app/engine status light. Every pose is a set of numbers that ease toward per-state targets, so any
// state can follow any other smoothly.
export type MascotState = "sleeping" | "waking" | "awake" | "listening" | "thinking" | "working" | "error";

type Pose = {
  close: number; // eyelids, 0 open .. 1 closed
  happy: number; // ^ ^ eyes instead of open eyes when > 0.5
  yawn: number;
  oh: number;
  ear: number; // -1 droop .. 0 rest .. 1 perk
  wiggle: number; // ear twitch (radians)
  waves: number; // 0..1, how many sound arcs show
  lookX: number;
  lookY: number;
  sx: number; // squash/stretch, scaled from the base
  sy: number;
  bob: number; // hop height
  tilt: number; // lean, + toward the viewer's left
  nod: number; // forward/back rock
};

const REST: Pose = {
  close: 0, happy: 0, yawn: 0, oh: 0, ear: 0, wiggle: 0, waves: 0,
  lookX: 0, lookY: 0, sx: 1, sy: 1, bob: 0, tilt: 0, nod: 0,
};

const TAU = Math.PI * 2;
const wave = (t: number, period: number) => Math.sin((t / period) * TAU);
const bump = (x: number) => (x <= 0 || x >= 1 ? 0 : Math.sin(x * Math.PI));

/** Blink curve: closed for ~140 ms every few seconds, at stable pseudo-random times. */
function blink(t: number, seed: number) {
  const period = 3.4 + 1.6 * Math.abs(Math.sin(Math.floor(t / 4.2) * 12.9898 + seed));
  return bump(((t + seed) % period) / 0.16);
}

/** Target pose for a state. t = seconds in this state, T = global clock, calm = reduced motion. */
function target(state: MascotState, t: number, T: number, level: number, calm: boolean, seed: number): Pose {
  const m = calm ? 0 : 1;
  const breathe = wave(T, state === "sleeping" ? 4.2 : 3.2) * m;
  const p: Pose = { ...REST, sy: 1 + 0.018 * breathe, sx: 1 - 0.009 * breathe };
  switch (state) {
    case "sleeping":
      p.close = 1;
      p.ear = -0.35;
      p.tilt = 0.06;
      p.nod = 0.05;
      p.sy = 1 - 0.02 + 0.03 * breathe;
      p.sx = 1 + 0.01 - 0.014 * breathe;
      p.oh = 0.25 + 0.2 * breathe;
      return p;
    case "waking": {
      // Trying to wake up: yawn and stretch, eyes flutter, nod back off, repeat until loaded.
      if (calm) return { ...p, close: 0.55, ear: 0 };
      const u = t % 3.6;
      const yawn = bump(u / 1.3);
      p.yawn = yawn;
      p.sy = 1 + 0.06 * yawn + 0.012 * breathe;
      p.sx = 1 - 0.03 * yawn;
      p.close = u < 1.3 ? 0.9 : u < 2.5 ? 0.5 + 0.45 * Math.cos((u - 1.3) * TAU * 2.4) : 0.55 + 0.35 * bump((u - 2.5) / 1.1);
      p.ear = u < 1.3 ? -0.2 + 0.5 * yawn : u < 2.5 ? 0.25 : 0.25 - 0.45 * bump((u - 2.5) / 1.1);
      p.tilt = u > 2.5 ? 0.06 * bump((u - 2.5) / 1.1) : -0.02 * yawn;
      p.nod = u > 2.5 ? 0.07 * bump((u - 2.5) / 1.1) : -0.03 * yawn;
      return p;
    }
    case "awake":
      // A happy beat right after waking, then open eyes, idle blinks and a little sway.
      p.happy = t < 0.9 ? 1 : 0;
      p.close = calm ? 0 : blink(T, seed);
      p.ear = 0.15;
      p.tilt = 0.025 * wave(T, 5.5) * m;
      p.lookX = 0.15 * wave(T, 7.3) * m;
      return p;
    case "listening": {
      const l = Math.max(0, Math.min(1, level));
      p.close = calm ? 0 : blink(T, seed) * 0.8;
      p.ear = 1;
      p.wiggle = (0.05 + 0.2 * l) * (calm ? 0 : Math.sin(T * 9)) * l + 0.06 * l;
      p.waves = calm ? 1 : 0.3 + 0.7 * l;
      p.tilt = -0.05;
      p.lookX = 0.35;
      p.oh = 0.15 * l;
      p.sy += 0.02 * l;
      return p;
    }
    case "thinking": {
      // Eyes wander up and to the side; a gentle bob.
      const side = calm ? -1 : Math.sign(wave(T, 5.2)) || 1;
      p.lookX = 0.7 * side;
      p.lookY = 0.85;
      p.close = 0.12 + (calm ? 0 : blink(T, seed) * 0.8);
      p.ear = 0.35;
      p.oh = 0.3;
      p.tilt = 0.05 * side;
      p.bob = 0.03 * (0.5 + 0.5 * wave(T, 1.6)) * m;
      return p;
    }
    case "working": {
      // Focused: narrowed eyes, ear forward, a steady little hop with squash on landing.
      p.close = 0.42;
      p.ear = 0.55;
      p.lookY = -0.2;
      if (!calm) {
        const u = (T % 0.8) / 0.8;
        const air = bump(u / 0.62);
        const land = u > 0.62 ? bump((u - 0.62) / 0.38) : 0;
        p.bob = 0.09 * air;
        p.sy = 1 + 0.05 * air - 0.08 * land;
        p.sx = 1 - 0.025 * air + 0.05 * land;
        p.wiggle = 0.06 * Math.sin(T * 7.8);
      }
      return p;
    }
    case "error":
      // Droopy and dizzy: ear flops, eyes half shut, the head wobbles in small circles.
      p.ear = -1;
      p.close = 0.45;
      p.oh = 0.55;
      p.lookY = -0.3;
      p.tilt = calm ? 0.08 : 0.08 * Math.sin(T * 2.6);
      p.nod = calm ? 0.04 : 0.06 * Math.cos(T * 2.6);
      p.sy = 0.97;
      p.sx = 1.015;
      return p;
  }
}

// ---------------------------------------------------------------- model loading (shared)

let model: Promise<GLTF> | null = null;
function loadModel() {
  if (!model) {
    const bin = atob(ZUNOS_GLB_BASE64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    model = loader.parseAsync(bytes.buffer, "");
  }
  return model;
}

type Rig = {
  group: Object3D;
  root: Object3D;
  eyes: Object3D[];
  eyeHome: Vector3[];
  happy: Object3D;
  bill: Object3D;
  billHome: Vector3;
  mouth: Object3D;
  ear: Object3D;
  earPivot: Object3D;
  earHome: number;
  waves: Object3D[];
  waveScale: number[];
  showWaves: boolean;
};

function rig(gltf: GLTF): Rig {
  const root = gltf.scene.clone(true);
  const get = <T extends Object3D = Object3D>(name: string) => root.getObjectByName(name) as T;
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const mats: Material[] = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of mats) {
      if (mat instanceof MeshPhysicalMaterial && mat.sheen > 0) {
        // Velvet: a soft sheen rim and almost no specular, so it reads as plush, not plastic.
        mat.sheenRoughness = 0.5;
        mat.specularIntensity = 0.25;
        mat.envMapIntensity = 0.8;
        if (mat.normalMap) {
          // Fine fibres: tile the fur normal map and keep it shallow.
          mat.normalMap.wrapS = mat.normalMap.wrapT = RepeatWrapping;
          mat.normalMap.repeat.set(7, 5);
          mat.normalScale.setScalar(0.35);
        }
      }
    }
  });
  const eyes = [get("EyeL"), get("EyeR")];
  const bill = get("Bill");
  const earPivot = get("EarPivot");
  return {
    group: root,
    root: get("Bean"),
    eyes,
    eyeHome: eyes.map((e) => e.position.clone()),
    happy: get("EyesHappy"),
    bill,
    billHome: bill.position.clone(),
    mouth: get("Mouth"),
    ear: get("Ear"),
    earPivot,
    earHome: earPivot.rotation.z,
    waves: ["Wave1", "Wave2", "Wave3"].map((n) => get(n)),
    // Node scales carry the meshopt quantization, so animate relative to them.
    waveScale: ["Wave1", "Wave2", "Wave3"].map((n) => get(n).scale.x),
    showWaves: true,
  };
}

/** Set a morph on a node; multi-material meshes load as a group of primitives sharing the targets. */
function morph(node: Object3D, name: string, value: number) {
  node.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const i = o.morphTargetDictionary?.[name];
    if (i !== undefined && o.morphTargetInfluences) o.morphTargetInfluences[i] = value;
  });
}

function apply(r: Rig, p: Pose) {
  r.root.scale.set(p.sx, p.sy, p.sx);
  r.root.position.y = p.bob;
  r.root.rotation.set(p.nod, 0, p.tilt);
  const happy = p.happy > 0.5;
  r.happy.visible = happy;
  r.eyes.forEach((eye, i) => {
    eye.visible = !happy;
    morph(eye, "close", Math.max(0, Math.min(1, p.close)));
    eye.position.copy(r.eyeHome[i]).add(new Vector3(p.lookX * 0.035, p.lookY * 0.035, 0));
  });
  morph(r.mouth, "yawn", p.yawn);
  morph(r.mouth, "o", p.oh);
  r.bill.position.copy(r.billHome).add(new Vector3(0, p.yawn * 0.05, p.yawn * 0.015));
  morph(r.ear, "perk", Math.max(0, p.ear));
  morph(r.ear, "droop", Math.max(0, -p.ear));
  r.earPivot.rotation.z = r.earHome + p.wiggle;
  r.waves.forEach((w, i) => {
    const k = r.showWaves ? Math.max(0, Math.min(1, p.waves * 3 - i)) : 0;
    w.visible = k > 0.02;
    w.scale.setScalar(r.waveScale[i] * (0.6 + 0.4 * k));
  });
}

function lerpPose(a: Pose, b: Pose, k: number) {
  for (const key of Object.keys(a) as (keyof Pose)[]) {
    a[key] += (b[key] - a[key]) * k;
  }
  // Booleans-in-disguise switch immediately.
  a.happy = b.happy;
}

function settled(a: Pose, b: Pose) {
  return (Object.keys(a) as (keyof Pose)[]).every((k) => Math.abs(a[k] - b[k]) < 1e-3);
}

// ---------------------------------------------------------------- component

// The floating z's are plain DOM over the canvas; their keyframes ship with the component.
const ZZZ_CSS = `
.zn-mascot-zzz { position: absolute; right: -8%; top: -14%; pointer-events: none; font-weight: 700;
  font-family: ui-rounded, system-ui, sans-serif; color: color-mix(in oklab, currentColor 55%, transparent); }
.zn-mascot-zzz i { position: absolute; font-style: normal; opacity: 0; animation: zn-zzz 3.6s ease-out infinite; }
.zn-mascot-zzz i:nth-child(2) { animation-delay: 1.2s; }
.zn-mascot-zzz i:nth-child(3) { animation-delay: 2.4s; }
@keyframes zn-zzz {
  0% { transform: translate(0, 0.6em) scale(0.6); opacity: 0; }
  20% { opacity: 1; }
  100% { transform: translate(0.9em, -0.9em) scale(1.1); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .zn-mascot-zzz i { animation: none; opacity: 0.8; }
  .zn-mascot-zzz i:nth-child(2), .zn-mascot-zzz i:nth-child(3) { display: none; }
}`;
let zzzStyled = false;
function styleZzz() {
  if (zzzStyled || typeof document === "undefined") return;
  zzzStyled = true;
  const el = document.createElement("style");
  el.textContent = ZZZ_CSS;
  document.head.appendChild(el);
}

export function Mascot3D({
  state = "awake",
  level = 0,
  size = 64,
  className,
  zzz = true,
}: {
  state?: MascotState;
  /** Mic level 0..1; only used while listening. */
  level?: number;
  size?: number;
  className?: string;
  /** Floating z's while sleeping. */
  zzz?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ state, level, since: 0, wake: () => {} });
  live.current.level = level;
  if (live.current.state !== state) {
    live.current.state = state;
    live.current.since = performance.now() / 1000;
  }

  useEffect(() => {
    live.current.wake();
  }, [state, level]);
  useEffect(styleZzz, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let raf = 0;
    let visible = true;
    const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
    // Small sizes need extra pixels to stay crisp; large ones cap the cost.
    const dpr = Math.min(window.devicePixelRatio || 1, size <= 48 ? 3 : 2);
    renderer.setPixelRatio(Math.min(dpr, 768 / size));
    renderer.setSize(size, size, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    const scene = new Scene();
    const pmrem = new PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.55;
    const key = new DirectionalLight(0xfff3e6, 2.4);
    key.position.set(-3, 5, 4.5);
    const rim = new DirectionalLight(0xffe8d6, 1.6);
    rim.position.set(2.5, 3.5, -4);
    scene.add(key, rim, new HemisphereLight(0xfff6ee, 0x5a2a1c, 0.55));

    const camera = new PerspectiveCamera(24, 1, 0.1, 50);
    const seed = Math.random() * 10;
    let r: Rig | null = null;
    const pose: Pose = { ...REST };
    let last = performance.now() / 1000;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");

    const frame = () => {
      raf = 0;
      if (disposed || !r || !visible || document.hidden) return;
      const now = performance.now() / 1000;
      // About 30 fps is plenty for a status light (20 while asleep); skip frames in between.
      if (now - last < (live.current.state === "sleeping" ? 1 / 20 : 1 / 30) - 0.004) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = Math.min(0.1, now - last);
      last = now;
      const { state: s, level: l, since } = live.current;
      const goal = target(s, now - since, now, l, calm.matches, seed);
      lerpPose(pose, goal, 1 - Math.exp(-dt * (calm.matches ? 14 : 9)));
      apply(r, pose);
      renderer.render(scene, camera);
      // Reduced motion: stop once the pose has arrived; a prop change wakes the loop.
      if (calm.matches && settled(pose, goal)) return;
      raf = requestAnimationFrame(frame);
    };
    const wake = () => {
      if (!raf && !disposed) {
        last = performance.now() / 1000 - 1;
        raf = requestAnimationFrame(frame);
      }
    };
    live.current.wake = wake;

    loadModel().then((gltf) => {
      if (disposed) return;
      r = rig(gltf);
      scene.add(r.group);
      // Frame the bean and its ear tightly so it reads at rail size. Large sizes also make room for
      // the sound arcs; small ones never show them. The frame is fixed, so nothing jumps between states.
      r.showWaves = size >= 72;
      const box = new Box3();
      for (const name of ["Body", "Ear", ...(r.showWaves ? ["Waves"] : [])]) box.expandByObject(r.group.getObjectByName(name)!);
      const center = box.getCenter(new Vector3());
      const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y) * (r.showWaves ? 1.06 : 1.02);
      const dist = span / 2 / Math.tan((camera.fov * Math.PI) / 360);
      camera.position.set(center.x - dist * 0.12, center.y + dist * 0.12, dist);
      camera.lookAt(center);
      Object.assign(pose, target(live.current.state, 99, performance.now() / 1000, 0, true, seed));
      wake();
    });

    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) wake();
    });
    io.observe(canvas);
    const onVisibility = () => !document.hidden && wake();
    document.addEventListener("visibilitychange", onVisibility);
    calm.addEventListener("change", wake);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      calm.removeEventListener("change", wake);
      env.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    };
  }, [size]);

  return (
    <span
      className={cn("zn-mascot relative inline-block shrink-0", className)}
      style={{ width: size, height: size }}
      data-state={state}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} style={{ width: size, height: size, display: "block" }} />
      {zzz && state === "sleeping" && (
        <span className="zn-mascot-zzz" style={{ fontSize: Math.max(8, size * 0.2) }}>
          <i>z</i>
          <i>z</i>
          <i>z</i>
        </span>
      )}
    </span>
  );
}
