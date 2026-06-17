// The planet/node view: the goal-loop owner is the core; each plan step is a
// node orbiting it; subagents and activity pulse along the wires. This is one
// projection of the same store the Kanban reads - the nodes ARE the plan steps.
// react-three-fiber for the canvas only; everything else stays DOM.

import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Line, OrbitControls, Text } from "@react-three/drei";
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

function Core({ passed, total }: { passed: number; total: number }) {
  const mesh = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (mesh.current) {
      const t = state.clock.elapsedTime;
      const s = 1 + Math.sin(t * 1.5) * 0.04;
      mesh.current.scale.setScalar(s);
    }
  });
  // Probe health ring: green arc proportional to passing win conditions.
  const ringPoints = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const frac = total > 0 ? passed / total : 0;
    const segments = 64;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2 * frac - Math.PI / 2;
      pts.push(new THREE.Vector3(Math.cos(a) * 1.5, Math.sin(a) * 1.5, 0));
    }
    return pts;
  }, [passed, total]);
  return (
    <group>
      <mesh ref={mesh}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshStandardMaterial
          color="#fb923c"
          emissive="#f97316"
          emissiveIntensity={0.6}
          roughness={0.4}
        />
      </mesh>
      {total > 0 && ringPoints.length > 1 && (
        <Line points={ringPoints} color="#34d399" lineWidth={3} />
      )}
      <Text position={[0, -1.9, 0]} fontSize={0.32} color="#cbd5e1" anchorX="center">
        {total > 0 ? `${passed}/${total} win conditions` : "core"}
      </Text>
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
  useFrame((state) => {
    if (mesh.current && step.status === "doing") {
      const t = state.clock.elapsedTime;
      const mat = mesh.current.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 0.5 + Math.sin(t * 4) * 0.4;
    }
  });
  const color = STATUS_COLOR[step.status] ?? "#475569";
  return (
    <group position={position}>
      <Line points={[[0, 0, 0], [-position[0], -position[1], 0]]} color="#1e293b" lineWidth={1} />
      <mesh
        ref={mesh}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
      >
        <sphereGeometry args={[selected ? 0.5 : 0.38, 24, 24]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={step.status === "doing" ? 0.8 : step.status === "done" ? 0.4 : 0.15}
          roughness={0.5}
        />
      </mesh>
      <Text
        position={[0, 0.7, 0]}
        fontSize={0.26}
        color={selected ? "#ffffff" : "#94a3b8"}
        anchorX="center"
        maxWidth={3}
      >
        {step.title.slice(0, 40)}
      </Text>
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

function Pulses({ steps }: { steps: PlanStep[] }) {
  const pulses = useStore((s) => s.pulses);
  const travels = useRef<Travel[]>([]);
  const seen = useRef(0);
  const group = useRef<THREE.Group>(null);

  useEffect(() => {
    for (const p of pulses) {
      if (p.id <= seen.current) continue;
      seen.current = p.id;
      // Match the pulse to a node by task title if possible, else the core halo.
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
      // progress/merged travel node->core; spawned travels core->node.
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
          <sphereGeometry args={[0.16, 12, 12]} />
          <meshBasicMaterial color="#38bdf8" />
        </mesh>
      ))}
    </group>
  );
}

// Sub-agents orbit on an outer ring as labeled satellites of the core.
function Subagent(
  { title, state, position }: {
    title: string;
    state: "running" | "merged";
    position: [number, number, number];
  },
) {
  const mesh = useRef<THREE.Mesh>(null);
  useFrame((s) => {
    if (mesh.current && state === "running") {
      const mat = mesh.current.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 0.4 + Math.sin(s.clock.elapsedTime * 5) * 0.35;
    }
  });
  const color = state === "merged" ? "#38bdf8" : "#a78bfa";
  return (
    <group position={position}>
      <Line points={[[0, 0, 0], [-position[0], -position[1], 0]]} color="#312e54" lineWidth={1} />
      <mesh ref={mesh}>
        <icosahedronGeometry args={[0.32, 0]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} roughness={0.4} />
      </mesh>
      <Text position={[0, 0.6, 0]} fontSize={0.22} color="#a5b4fc" anchorX="center" maxWidth={3}>
        {title.slice(0, 32)}
      </Text>
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
  const subRadius = RADIUS + 2.6;

  return (
    <div className="relative min-h-0 flex-1">
      <Canvas
        camera={{ position: [0, 0, subagents.length ? 18 : 13], fov: 50 }}
        onPointerMissed={() => selectTask(null)}
      >
        <ambientLight intensity={0.6} />
        <pointLight position={[0, 0, 6]} intensity={1.2} />
        {/* Scroll to zoom, drag to orbit, right-drag to pan. */}
        <OrbitControls
          enablePan
          enableZoom
          enableRotate
          minDistance={4}
          maxDistance={40}
          makeDefault
        />
        <Core passed={passed} total={goalProbes.length} />
        {steps.map((step, i) => (
          <Node
            key={`${i}-${step.title}`}
            step={step}
            position={nodePosition(i, steps.length)}
            selected={selectedTaskId === step.title}
            onSelect={() => selectTask(step.title)}
          />
        ))}
        {subagents.map((sa, i) => {
          const angle = (i / Math.max(subagents.length, 1)) * Math.PI * 2 - Math.PI / 2 + 0.4;
          return (
            <Subagent
              key={`sa-${i}-${sa.title}`}
              title={sa.title}
              state={sa.state}
              position={[Math.cos(angle) * subRadius, Math.sin(angle) * subRadius, 0]}
            />
          );
        })}
        <Pulses steps={steps} />
      </Canvas>
      <div className="pointer-events-none absolute left-3 top-3 text-xs text-slate-500">
        <span className="text-orange-400">●</span> main agent ·{" "}
        <span className="text-violet-400">◆</span> sub-agents ({subagents.length}) ·{" "}
        <span className="text-slate-600">scroll to zoom, drag to orbit</span>
      </div>
    </div>
  );
}
