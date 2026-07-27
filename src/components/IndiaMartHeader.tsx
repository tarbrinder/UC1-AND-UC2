import { Store, MessageCircle, HelpCircle, Globe, User, ChevronDown, X } from 'lucide-react';

// Shared IndiaMART top nav for the STANDALONE full-page RFQ routes. Recreated wordmark (no logo asset in the
// repo). Nav items are chrome (non-functional). The location dropdown / search bar / Get-Best-Price CTA are
// intentionally omitted (owner). Used by SimpleRFQForm (standalone) and StandardRFQForm.
// ⚑ DEV-TODO: the greeting is the demo identity. Show the real signed-in buyer's name from the account session;
//   render "Guest" (no name) when unauthenticated. `onExit` gives every standalone surface a persistent exit
//   at ALL widths (fixes P1-102 / P1-125 — the exit used to hide below the md breakpoint).
export default function IndiaMartHeader({ firstName = '', onExit }: { firstName?: string; onExit?: () => void }) {
  return (
    <header className="shrink-0 h-16 bg-[#2e3192] text-white flex items-center gap-6 px-6 shadow-[0_1px_3px_0_rgba(30,42,58,0.2)]">
      <div className="flex items-center gap-2 select-none">
        <span className="w-8 h-8 rounded-full bg-white flex items-center justify-center shrink-0"><span className="text-[#e4002b] font-black text-lg leading-none">M</span></span>
        <span className="text-xl font-extrabold tracking-tight lowercase">indiamart<span className="text-[9px] align-super font-semibold">®</span></span>
      </div>
      <div className="flex-1" />
      <nav className="flex items-center gap-6">
        {[{ Icon: Store, label: 'Seller Tools' }, { Icon: MessageCircle, label: 'Messages' }, { Icon: HelpCircle, label: 'Help' }, { Icon: Globe, label: 'Exporters' }].map(({ Icon, label }) => (
          <span key={label} className="hidden sm:flex flex-col items-center gap-0.5 text-white/90 cursor-default"><Icon size={18} /><span className="text-[11px]">{label}</span></span>
        ))}
        <span className="flex items-center gap-1.5 cursor-default"><span className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center"><User size={16} /></span><span className="text-sm">{firstName ? `Hi ${firstName}` : 'Guest'}</span><ChevronDown size={14} className="text-white/70" /></span>
        {onExit && <button type="button" onClick={onExit} aria-label="Exit form" className="flex items-center gap-1 text-white/90 hover:text-white text-sm rounded-lg px-2 py-1 hover:bg-white/10"><X size={16} /> Exit</button>}
      </nav>
    </header>
  );
}
