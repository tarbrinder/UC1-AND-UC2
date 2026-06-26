// ─── NODE CARDS (Module 1 · Step 3) — executive vs technical translation for EVERY node ─────────────
// Closes the "const __t0 = $('t0')… is a black box" complaint. Each source node gets a CEO-readable card
// (what it does · why · in · out) PLUS the raw technical view. PURE · static dictionary. The authoritative
// card for an n8n node arrives when that node emits its own Summary (E1) — this is the dependable baseline
// so nothing is ever an unexplained black box.

import type { SourceNode } from './ledger';

export interface NodeCard {
  node: string; kind: 'api' | 'code' | 'llm' | 'transform';
  title: string;            // executive name ("WA Wrapper Cleaner")
  purpose: string;          // why it exists, plain English
  input: string; output: string;
  technical?: string;       // the raw code/shape an engineer sees
}

export const NODE_DICTIONARY: Record<SourceNode, NodeCard> = {
  'profile-api': { node: 'profile-api', kind: 'api', title: 'Buyer Profile API', purpose: 'Pulls the buyer’s registered profile (the system-of-record identity).', input: 'GLID', output: 'name · city · company description · mobile · location preference · verified flag' },
  glusr: { node: 'glusr', kind: 'api', title: 'GLUSR · Account', purpose: 'Account-level fields from the GLUSR Redash node (usersince) — member-since · last-modified · last-login + any other non-empty column.', input: 'GLID', output: 'glusr_usr_membersince · glusr_usr_lastmodified · glusr_usr_last_logged_in · …' },
  'pns-insights': { node: 'pns-insights', kind: 'llm', title: 'PNS Call Insights', purpose: 'Structured insights distilled from the buyer’s past sales calls (persona, intent, application) — NOT category PNS.', input: 'GLID → call transcripts', output: 'per-call: buyer_persona · intent narrative · intended application · seller questions' },
  'prev-bl': { node: 'prev-bl', kind: 'api', title: 'Previous BuyLeads', purpose: 'The buyer’s prior posted requirements — shows what they actually procure.', input: 'GLID', output: 'list of prior BL titles + dates' },
  'prev-isq': { node: 'prev-isq', kind: 'api', title: 'Previous ISQ Answers', purpose: 'Specs the buyer answered on past requirements — reusable buyer memory.', input: 'GLID', output: 'per-category answered specs' },
  csl: { node: 'csl', kind: 'api', title: 'CSL (Browse/Search)', purpose: 'The buyer’s on-site search + browse activity — live intent + where they browse from.', input: 'GLID', output: 'search terms · browse cities' },
  'wa-out': { node: 'wa-out', kind: 'code', title: 'WhatsApp · Our messages', purpose: 'Messages IndiaMART SENT the buyer (seller shares / marketing), from either channel. CONTEXT for reading the buyer reply — never buyer intent (a seller name + location we sent ≠ the buyer wants it). Channel volume feeds the channel-affinity signal.', input: 'raw WhatsApp webhook response', output: 'clean outbound message records + count', technical: "root = Array.isArray(input)?input[0]:input; records = Array.isArray(root?.data)?root.data.length:(root?1:0); return [{json:{whatsapp_out:JSON.stringify(root), __health:{records}}}]" },
  'wa-in': { node: 'wa-in', kind: 'code', title: 'WhatsApp · Buyer messages', purpose: 'WhatsApp messages the BUYER sent / replied (from either channel — inbound 9696 or outbound) — first-class buyer signal. Flags a 404 = no inbound chat for this GLID vs a real wrapper error, and strips request metadata. Pure code — no LLM.', input: 'raw inbound-WA webhook response (may be a 404 or wrapper error)', output: 'clean inbound WA records + a health flag (ok / no-context / error)', technical: "if(root?.error){is404=/404/.test(msg); return {success:false, whatsapp_inbound:null, __health:__h(is404,0,…)}} … success → {whatsapp_inbound:JSON.stringify(root), __health:__h(true,records,null)}" },
  befisc: { node: 'befisc', kind: 'api', title: 'Befisc (External Identity)', purpose: 'Paid third-party identity lookup by mobile — a TRUSTWORTHY first-class buyer signal (identity · vintage · scale), weighted like PNS.', input: 'mobile number', output: 'name · gender · age · income band · PAN · address' },
  sign3: { node: 'sign3', kind: 'api', title: 'Sign3 (Social Presence)', purpose: 'Paid third-party digital-footprint lookup by mobile — a TRUSTWORTHY first-class buyer signal (legitimacy · trust · presence).', input: 'mobile number', output: 'social profiles · operator' },
};

export function nodeCard(node: SourceNode): NodeCard | null { return NODE_DICTIONARY[node] || null; }
