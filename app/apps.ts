// Everything this box serves, for the phone UI's Apps launcher (main.tsx) and the retro
// desktop's Sites menu (desktop.tsx). Paths are same-origin and open in place; URLs with a host
// are separate vhosts and open in a new tab. hallpass.brandmcd.com is left out: its vhost only
// redirects to umichresources.brandmcd.com/rooms.
export type HostedApp = { id: string; label: string; icon: string; desc: string; href: string; external?: boolean };

export const APPS: HostedApp[] = [
  { id: "chat", label: "Chat", icon: "💬", desc: "Claude conversations", href: "/app" },
  { id: "tty", label: "Terminal", icon: "⌨", desc: "Claude Code in tmux tabs", href: "/tty/" },
  { id: "yak", label: "Yak picks", icon: "🐐", desc: "Ranked Yik Yak post ideas", href: "/yak/" },
  { id: "brief", label: "Brief", icon: "📰", desc: "Daily morning brief", href: "/brief/" },
  { id: "usage", label: "Usage", icon: "📊", desc: "Token usage dashboard", href: "/usage/" },
  { id: "code", label: "VS Code", icon: "💻", desc: "code-server editor", href: "/code/" },
  { id: "survivor", label: "Survivor", icon: "🏈", desc: "NFL survivor pool", href: "https://survivor.brandmcd.com/", external: true },
  { id: "parlay", label: "Parlay", icon: "🎲", desc: "CFB and NFL parlay picks", href: "https://parlay.brandmcd.com/", external: true },
  { id: "umich", label: "UMich", icon: "〽️", desc: "Campus resources", href: "https://umichresources.brandmcd.com/", external: true },
];
