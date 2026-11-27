import { useState } from "react";

/*
 * Real map and agent art from valorant-api.com's media CDN (Riot's own game
 * assets; allowed for fan projects under Riot's "Legal Jibber Jabber" policy).
 * Images load by UUID, so no API call is needed. Offline, or for a map or
 * agent added after this list, a drawn gradient with initials stands in.
 */
const CDN = "https://media.valorant-api.com";
const key = (name: string) => name.toLowerCase().replace(/[^a-z]/g, "");

const AGENTS: Record<string, string> = {
  astra: "41fb69c1-4189-7b37-f117-bcaf1e96f1bf",
  breach: "5f8d3a7f-467b-97f3-062c-13acf203c006",
  brimstone: "9f0d8ba9-4140-b941-57d3-a7ad57c6b417",
  chamber: "22697a3d-45bf-8dd7-4fec-84a9e28c69d7",
  clove: "1dbf2edd-4729-0984-3115-daa5eed44993",
  cypher: "117ed9e3-49f3-6512-3ccf-0cada7e3823b",
  deadlock: "cc8b64c8-4b25-4ff9-6e7f-37b4da43d235",
  fade: "dade69b4-4f5a-8528-247b-219e5a1facd6",
  gekko: "e370fa57-4757-3604-3648-499e1f642d3f",
  harbor: "95b78ed7-4637-86d9-7e41-71ba8c293152",
  hush: "ddd5a15c-4fbe-42fa-3789-11a55ca5ee04",
  iso: "0e38b510-41a8-5780-5e8f-568b2a4f2d6c",
  jett: "add6443a-41bd-e414-f6ad-e58d267f4e95",
  kayo: "601dbbe7-43ce-be57-2a40-4abd24953621",
  killjoy: "1e58de9c-4950-5125-93e9-a0aee9f98746",
  miks: "7c8a4701-4de6-9355-b254-e09bc2a34b72",
  neon: "bb2a4828-46eb-8cd1-e765-15848195d751",
  omen: "8e253930-4c05-31dd-1b6c-968525494517",
  phoenix: "eb93336a-449b-9c1b-0a54-a891f7921d69",
  raze: "f94c3b30-42be-e959-889c-5aa313dba261",
  reyna: "a3bfb853-43b2-7238-a4f1-ad90e9e46bcc",
  sage: "569fdd95-4d10-43ab-ca70-79becc718b46",
  skye: "6f2a04ca-43e0-be17-7f36-b3908627744d",
  sova: "320b2a48-4d9b-a075-30f1-1f93a9b638fa",
  tejo: "b444168c-4e35-8076-db47-ef9bf368f384",
  veto: "92eeef5d-43b5-1d4a-8d03-b3927a09034b",
  viper: "707eab51-4836-f488-046a-cda6bf494859",
  vyse: "efba5359-4016-a1e5-7626-b1ae76895940",
  waylay: "df1cb487-4902-002e-5c17-d28e83e78588",
  yoru: "7f94d92c-4234-0a36-9646-3a87eb8b5c89",
};

const MAPS: Record<string, string> = {
  abyss: "224b0a95-48b9-f703-1bd8-67aca101a61f",
  ascent: "7eaecc1b-4337-bbf6-6ab9-04b8f06b3319",
  bind: "2c9d57ec-4431-9c5e-2939-8f9ef6dd5cba",
  breeze: "2fb9a4fd-47b8-4e7d-a969-74b4046ebd53",
  corrode: "1c18ab1f-420d-0d8b-71d0-77ad3c439115",
  district: "690b3ed2-4dff-945b-8223-6da834e30d24",
  drift: "2c09d728-42d5-30d8-43dc-96a05cc7ee9d",
  fracture: "b529448b-4d60-346e-e89e-00a4c527a405",
  glitch: "d6336a5a-428f-c591-98db-c8a291159134",
  haven: "2bee0dc9-4ffe-519b-1cbd-7fbe763a6047",
  icebox: "e2ad5c54-4114-a870-9641-8ea21279579a",
  kasbah: "12452a9d-48c3-0b02-e7eb-0381c3520404",
  lotus: "2fe4ed3a-450a-948b-6d6b-e89a78e680a9",
  pearl: "fd267378-4d1d-484f-ff52-77821ed10dc2",
  piazza: "de28aa9b-4cbe-1003-320e-6cb3ec309557",
  split: "d960549e-485c-e861-8d71-aa9d1aed12a2",
  summit: "756da597-416b-c0f2-f47b-afbdf28670bc",
  sunset: "92584fbe-486a-b1b2-9faa-39b0f486b498",
};

/** Full 16:9 art for a map (valorant-api.com splash), used as a clip's picture when it has no thumbnail. */
export function mapArt(map?: string | null): string | null {
  const id = map ? MAPS[key(map)] : undefined;
  return id ? `${CDN}/maps/${id}/splash.png` : null;
}

/** Whether there's real art for this agent. */
export const hasAgentArt = (agent?: string | null) => Boolean(agent && AGENTS[key(agent)]);

/** A stable hue per name, for the drawn fallback. */
function hue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/** The map's banner art, cropped to a 16:9 thumb, with the agent you played over its corner. */
export function MapThumb({ map, agent }: { map: string; agent?: string }) {
  const id = MAPS[key(map)];
  const [failed, setFailed] = useState(false);
  const h = hue(map);
  return (
    <div className="relative shrink-0">
      <div
        className="relative h-[60px] w-[104px] overflow-hidden rounded-xl ring-1 ring-white/10 ring-inset"
        style={{ background: `linear-gradient(135deg, hsl(${h} 45% 28%), hsl(${(h + 40) % 360} 35% 12%))` }}
      >
        {id && !failed ? (
          <img
            src={`${CDN}/maps/${id}/listviewicon.png`}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setFailed(true)}
            className="absolute inset-0 size-full object-cover"
          />
        ) : (
          <span className="absolute inset-0 grid place-items-center text-[11px] font-semibold uppercase tracking-[0.14em] text-white/70">{map}</span>
        )}
        {/* Specular sheen and a soft vignette so the art reads as glass, not a sticker. */}
        <span aria-hidden className="absolute inset-0 bg-gradient-to-b from-white/[0.14] via-transparent to-black/45" />
      </div>
      {agent && <AgentIcon agent={agent} className="absolute -right-2 -bottom-2 size-8 ring-[2.5px] ring-zinc-950" />}
    </div>
  );
}

/** The agent's round minimap portrait. */
export function AgentIcon({ agent, className = "size-6" }: { agent: string; className?: string }) {
  const id = AGENTS[key(agent)];
  const [failed, setFailed] = useState(false);
  const h = hue(agent);
  return (
    <span
      title={agent}
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full shadow-lg shadow-black/40 ${className}`}
      style={{ background: `radial-gradient(circle at 30% 25%, hsl(${h} 50% 45%), hsl(${h} 45% 18%))` }}
    >
      {id && !failed ? (
        <img src={`${CDN}/agents/${id}/minimapportrait.png`} alt={agent} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} className="size-full object-cover" />
      ) : (
        <span className="text-[10px] font-bold text-white/90">{agent.slice(0, 2).toUpperCase()}</span>
      )}
    </span>
  );
}
