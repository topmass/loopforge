// The command center: a cinematic 3D view of the goal as a living system. The
// goal-loop owner is the glowing core; each plan step orbits it; sub-agents are
// satellites that come ALIVE while they work - breathing light, and a constant
// two-way stream of data particles flowing along the wires between each live
// agent and the core (telemetry home, instructions out). One projection of the
// same store the Kanban reads; the nodes ARE the plan steps.

import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Billboard, Line, OrbitControls, Stars, Text } from "@react-three/drei";
import * as THREE from "three";
import { useStore } from "./store";
import type { PlanStep } from "./types";

const RADIUS = 4.2;

const STATUS_COLOR: Record<string, string> = {
  todo: "#475569",
  doing: "#f97316",
  done: "#34d399",
};

function nodePosition(index: number, total: number): [number, number, number] {
  const angle = (index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2;
  return [Math.cos(angle) * RADIUS, Math.sin(angle) * RADIUS, 0];
}

// One soft radial-gradient texture, shared by every glow sprite. Built once on
// the client; gives us additive "bloom" without a postprocessing pass.
function useGlowTexture(): THREE.Texture {
  return useMemo(() => {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.25, "rgba(255,255,255,0.55)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, []);
}

function Glow({ color, scale, opacity = 0.85 }: { color: string; scale: number; opacity?: number }) {
  const tex = useGlowTexture();
  return (
    <sprite scale={[scale, scale, scale]}>
      <spriteMaterial
        map={tex}
        color={color}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        transparent
        opacity={opacity}
      />
    </sprite>
  );
}

// A continuous two-way stream of light particles along a wire: telemetry flows
// in (node -> core), instructions flow out (core -> node). This is what makes a
// live agent read as "talking to" the main agent between discrete events.
function DataStream(
  { from, to, color, active, count = 5 }: {
    from: THREE.Vector3;
    to: THREE.Vector3;
    color: string;
    active: boolean;
    count?: number;
  },
) {
  const group = useRef<THREE.Group>(null);
  const seed = useMemo(() => Math.abs(from.x * 7.13 + from.y * 3.7) % 1, [from]);
  useFrame((state) => {
    if (!group.current) return;
    const t = state.clock.elapsedTime;
    const kids = group.current.children as THREE.Mesh[];
    for (let i = 0; i < kids.length; i++) {
      const inbound = i < count; // first set: node -> core (telemetry home)
      const idx = i % count;
      const phase = (t * 0.55 + idx / count + seed) % 1;
      const a = inbound ? from : to;
      const b = inbound ? to : from;
      kids[i].position.lerpVectors(a, b, phase);
      const mat = kids[i].material as THREE.MeshBasicMaterial;
      kids[i].visible = active;
      // Fade in and out at the endpoints so particles bloom mid-flight.
      mat.opacity = active ? Math.sin(phase * Math.PI) * 0.9 : 0;
    }
  });
  return (
    <group ref={group}>
      {Array.from({ length: count * 2 }).map((_, i) => (
        <mesh key={i} visible={false}>
          <sphereGeometry args={[0.07, 8, 8]} />
          <meshBasicMaterial
            color={i < count ? color : "#7dd3fc"}
            blending={THREE.AdditiveBlending}
            transparent
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

function Core({ passed, total }: { passed: number; total: number }) {
  const mesh = useRef<THREE.Mesh>(null);
  const shell = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (mesh.current) {
      mesh.current.scale.setScalar(1 + Math.sin(t * 1.5) * 0.04);
    }
    if (shell.current) {
      shell.current.rotation.y = t * 0.25;
      shell.current.rotation.x = t * 0.12;
    }
  });
  // Probe health ring: green arc proportional to passing win conditions.
  const ringPoints = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const frac = total > 0 ? passed / total : 0;
    const segments = 64;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2 * frac - Math.PI / 2;
      pts.push(new THREE.Vector3(Math.cos(a) * 1.6, Math.sin(a) * 1.6, 0));
    }
    return pts;
  }, [passed, total]);
  return (
    <group>
      <Glow color="#fb923c" scale={6.5} opacity={0.5} />
      <Glow color="#f97316" scale={3.6} opacity={0.7} />
      <mesh ref={mesh}>
        <sphereGeometry args={[1, 48, 48]} />
        <meshStandardMaterial
          color="#fb923c"
          emissive="#f97316"
          emissiveIntensity={0.7}
          roughness={0.35}
          metalness={0.1}
        />
      </mesh>
      {/* Slowly rotating wireframe corona - the core "thinking". */}
      <mesh ref={shell}>
        <icosahedronGeometry args={[1.32, 1]} />
        <meshBasicMaterial color="#fdba74" wireframe transparent opacity={0.18} />
      </mesh>
      {total > 0 && ringPoints.length > 1 && (
        <Line points={ringPoints} color="#34d399" lineWidth={3} />
      )}
      <Billboard position={[0, -2.05, 0]}>
        <Text fontSize={0.32} color="#cbd5e1" anchorX="center">
          {total > 0 ? `${passed}/${total} win conditions` : "main agent"}
        </Text>
      </Billboard>
    </group>
  );
}

function Node(
  { step, position, selected, onSelect }: {
    step: PlanStep;
    position: [number, number, number];
    selected: boolean;
    onSelect: () => void;
  },
) {
  const mesh = useRef<THREE.Mesh>(null);
  const doing = step.status === "doing";
  useFrame((state) => {
    if (mesh.current && doing) {
      const mat = mesh.current.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 0.5 + Math.sin(state.clock.elapsedTime * 4) * 0.4;
    }
  });
  const color = STATUS_COLOR[step.status] ?? "#475569";
  return (
    <group position={position}>
      <Line
        points={[[0, 0, 0], [-position[0], -position[1], 0]]}
        color={doing ? "#7c3a12" : "#1e293b"}
        lineWidth={1}
      />
      {(doing || selected) && <Glow color={color} scale={1.6} opacity={0.6} />}
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        onPointerOver={() => (document.body.style.cursor = "pointer")}
        onPointerOut={() => (document.body.style.cursor = "default")}
      >
        <sphereGeometry args={[0.95, 12, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh ref={mesh}>
        <sphereGeometry args={[selected ? 0.5 : 0.38, 24, 24]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={doing ? 0.8 : step.status === "done" ? 0.4 : 0.15}
          roughness={0.5}
        />
      </mesh>
      <Billboard position={[0, 0.7, 0]}>
        <Text
          fontSize={0.26}
          color={selected ? "#ffffff" : "#94a3b8"}
          anchorX="center"
          maxWidth={3}
        >
          {step.title.slice(0, 40)}
        </Text>
      </Billboard>
    </group>
  );
}

interface Travel {
  id: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  start: number;
  color: string;
}

// Discrete event bursts (spawn / progress / merged / verified / blocked): a
// bright single packet that fires on the actual lifecycle event, layered over
// the ambient DataStreams.
function Pulses({ steps }: { steps: PlanStep[] }) {
  const pulses = useStore((s) => s.pulses);
  const travels = useRef<Travel[]>([]);
  const seen = useRef(0);
  const group = useRef<THREE.Group>(null);

  useEffect(() => {
    for (const p of pulses) {
      if (p.id <= seen.current) continue;
      seen.current = p.id;
      const idx = p.taskId ? steps.findIndex((s) => s.title === p.taskId) : -1;
      const target = idx >= 0
        ? new THREE.Vector3(...nodePosition(idx, steps.length))
        : new THREE.Vector3(0, 0, 0);
      const core = new THREE.Vector3(0, 0, 0);
      const color = p.kind === "goal.blocked"
        ? "#f59e0b"
        : p.kind === "verified"
        ? "#34d399"
        : "#38bdf8";
      const inbound = p.kind !== "subagent.spawned";
      travels.current.push({
        id: p.id,
        from: inbound ? target : core,
        to: inbound ? core : target,
        start: performance.now(),
        color,
      });
    }
  }, [pulses, steps]);

  useFrame(() => {
    if (!group.current) return;
    const now = performance.now();
    travels.current = travels.current.filter((t) => now - t.start < 1100);
    const children = group.current.children as THREE.Mesh[];
    for (let i = 0; i < children.length; i++) {
      const t = travels.current[i];
      if (!t) {
        children[i].visible = false;
        continue;
      }
      const p = Math.min((now - t.start) / 1000, 1);
      children[i].visible = true;
      children[i].position.lerpVectors(t.from, t.to, p);
      (children[i].material as THREE.MeshBasicMaterial).color.set(t.color);
    }
  });

  return (
    <group ref={group}>
      {Array.from({ length: 16 }).map((_, i) => (
        <mesh key={i} visible={false}>
          <sphereGeometry args={[0.18, 12, 12]} />
          <meshBasicMaterial
            color="#38bdf8"
            blending={THREE.AdditiveBlending}
            transparent
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

// Sub-agents orbit on an outer ring as labeled satellites. Running ones breathe
// light, spin, and keep a live DataStream to the core; merged ones go calm.
function Subagent(
  { title, state, position, selected, onSelect }: {
    title: string;
    state: "running" | "merged";
    position: [number, number, number];
    selected: boolean;
    onSelect: () => void;
  },
) {
  const mesh = useRef<THREE.Mesh>(null);
  const running = state === "running";
  useFrame((s) => {
    if (!mesh.current) return;
    const t = s.clock.elapsedTime;
    mesh.current.rotation.y = t * (running ? 1.4 : 0.3);
    mesh.current.rotation.x = t * 0.5;
    if (running) {
      const mat = mesh.current.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 0.5 + Math.sin(t * 5) * 0.4;
      mesh.current.scale.setScalar(1 + Math.sin(t * 3) * 0.08);
    }
  });
  const color = running ? "#a78bfa" : "#38bdf8";
  return (
    <group position={position}>
      <Line
        points={[[0, 0, 0], [-position[0], -position[1], 0]]}
        color={running ? "#4c1d95" : "#1e3a5f"}
        lineWidth={selected ? 2 : 1}
      />
      {(running || selected) && <Glow color={selected ? "#ede9fe" : "#a78bfa"} scale={selected ? 2.4 : 1.9} opacity={0.7} />}
      {/* Generous invisible hit target so a drifting satellite stays easy to click. */}
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        onPointerOver={() => (document.body.style.cursor = "pointer")}
        onPointerOut={() => (document.body.style.cursor = "default")}
      >
        <sphereGeometry args={[0.95, 12, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh ref={mesh}>
        <icosahedronGeometry args={[selected ? 0.44 : 0.34, 0]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={running ? 0.6 : 0.35}
          roughness={0.4}
          metalness={0.2}
        />
      </mesh>
      <Billboard position={[0, 0.62, 0]}>
        <Text
          fontSize={0.22}
          color={selected ? "#ffffff" : "#c4b5fd"}
          anchorX="center"
          maxWidth={3}
        >
          {title.replace(/^Spawned sub-agent\s*/i, "").slice(0, 32) || "sub-agent"}
        </Text>
      </Billboard>
      <Billboard position={[0, -0.58, 0]}>
        <Text fontSize={0.16} color={running ? "#a78bfa" : "#64748b"} anchorX="center">
          {running ? "coding" : "merged"}
        </Text>
      </Billboard>
    </group>
  );
}

export function NodeView({ goalId }: { goalId: string }) {
  const steps = useStore((s) => s.planByGoal[goalId]) ?? [];
  const subagents = useStore((s) => s.subagentsByGoal[goalId]) ?? [];
  const probes = useStore((s) => s.board?.probes ?? []);
  const selectedTaskId = useStore((s) => s.selectedTaskId);
  const selectTask = useStore((s) => s.selectTask);
  const goalProbes = probes.filter((p) => p.goalId === goalId);
  const passed = goalProbes.filter((p) => p.lastStatus === "passed").length;
  const subRadius = RADIUS + 2.8;
  const core = useMemo(() => new THREE.Vector3(0, 0, 0), []);
  const running = subagents.filter((s) => s.state === "running").length;

  // Pre-compute satellite positions so the wire/stream/satellite agree.
  const subPositions = subagents.map((_, i): [number, number, number] => {
    const angle = (i / Math.max(subagents.length, 1)) * Math.PI * 2 - Math.PI / 2 + 0.4;
    return [Math.cos(angle) * subRadius, Math.sin(angle) * subRadius, 0];
  });

  return (
    <div className="relative min-h-0 flex-1">
      <Canvas
        camera={{ position: [0, 0, subagents.length ? 19 : 14], fov: 50 }}
        onPointerMissed={() => selectTask(null)}
      >
        <color attach="background" args={["#07090e"]} />
        <fog attach="fog" args={["#07090e", 22, 70]} />
        <ambientLight intensity={0.55} />
        <pointLight position={[0, 0, 6]} intensity={1.3} color="#fb923c" />
        <pointLight position={[-10, 6, -8]} intensity={0.5} color="#818cf8" />
        <Stars radius={90} depth={50} count={1600} factor={3.2} saturation={0} fade speed={0.6} />

        {/* Scroll to zoom, drag to orbit, right-drag to pan; slow cinematic drift. */}
        <OrbitControls
          enablePan
          enableZoom
          enableRotate
          autoRotate
          autoRotateSpeed={0.14}
          minDistance={4}
          maxDistance={44}
          makeDefault
        />

        <Core passed={passed} total={goalProbes.length} />

        {steps.map((step, i) => {
          const pos = nodePosition(i, steps.length);
          return (
            <Node
              key={`${i}-${step.title}`}
              step={step}
              position={pos}
              selected={selectedTaskId === step.title}
              onSelect={() => selectTask(step.title)}
            />
          );
        })}

        {subagents.map((sa, i) => (
          <Subagent
            key={`sa-${i}-${sa.title}`}
            title={sa.title}
            state={sa.state}
            position={subPositions[i]}
            selected={selectedTaskId === sa.title}
            onSelect={() => selectTask(sa.title)}
          />
        ))}

        {/* Ambient bidirectional telemetry for every running sub-agent. */}
        {subagents.map((sa, i) =>
          sa.state === "running"
            ? (
              <DataStream
                key={`stream-${i}`}
                from={new THREE.Vector3(...subPositions[i])}
                to={core}
                color="#c4b5fd"
                active
              />
            )
            : null
        )}
        {/* The plan step currently being worked also streams to the core. */}
        {steps.map((step, i) =>
          step.status === "doing"
            ? (
              <DataStream
                key={`nstream-${i}`}
                from={new THREE.Vector3(...nodePosition(i, steps.length))}
                to={core}
                color="#fdba74"
                active
                count={4}
              />
            )
            : null
        )}

        <Pulses steps={steps} />
      </Canvas>

      <div className="pointer-events-none absolute left-3 top-3 text-xs text-slate-500">
        <span className="text-orange-400">●</span> main agent ·{" "}
        <span className="text-violet-400">◆</span> sub-agents ({subagents.length}
        {running > 0 ? `, ${running} live` : ""}) ·{" "}
        <span className="text-slate-600">scroll to zoom, drag to orbit</span>
      </div>
    </div>
  );
}
