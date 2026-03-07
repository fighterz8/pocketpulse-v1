import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Upload,
  ListChecks,
  TrendingDown,
  LogOut,
  Menu,
  Activity
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "@tanstack/react-query";

export function Sidebar({ className = "" }: { className?: string }) {
  const [location] = useLocation();
  const { logout } = useAuth();

  const { data: cashflow } = useQuery<any>({
    queryKey: ["/api/cashflow"],
  });

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/upload", label: "Upload CSV", icon: Upload },
    { href: "/transactions", label: "Ledger", icon: ListChecks },
    { href: "/leaks", label: "Leak Detection", icon: TrendingDown },
  ];

  return (
    <div className={`flex h-screen flex-col border-r bg-card text-card-foreground ${className}`}>
      <div className="p-6">
        <div className="flex items-center gap-2 font-bold text-2xl tracking-tight text-primary">
          <Activity className="h-6 w-6" />
          <span>PocketPulse</span>
        </div>
        <p className="text-xs text-muted-foreground mt-1 font-medium tracking-wide uppercase">Small Business</p>
      </div>

      <nav className="flex-1 space-y-1 px-4 py-2">
        {navItems.map((item) => {
          const isActive = location === item.href;
          return (
            <Link key={item.href} href={item.href}>
              <Button
                variant={isActive ? "secondary" : "ghost"}
                className={`w-full justify-start ${isActive ? "font-semibold" : "font-medium"}`}
                data-testid={`nav-${item.label.toLowerCase().replace(/\s/g, "-")}`}
              >
                <item.icon className="mr-3 h-5 w-5" />
                {item.label}
              </Button>
            </Link>
          );
        })}
      </nav>

      <div className="p-4 mt-auto">
        <div className="rounded-xl bg-muted p-4 mb-4">
          <p className="text-sm font-medium mb-1">Safe to Spend</p>
          <p className="text-2xl font-bold text-primary" data-testid="text-sidebar-safe-to-spend">
            {cashflow ? `$${cashflow.safeToSpend.toLocaleString()}` : "$0.00"}
          </p>
        </div>
        <Button
          variant="ghost"
          className="w-full justify-start text-muted-foreground hover:text-foreground"
          onClick={() => logout.mutate()}
          data-testid="button-logout"
        >
          <LogOut className="mr-3 h-5 w-5" />
          Sign Out
        </Button>
      </div>
    </div>
  );
}

export function MobileNav() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden">
          <Menu className="h-6 w-6" />
          <span className="sr-only">Toggle navigation menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="p-0 w-72">
        <Sidebar className="border-none" />
      </SheetContent>
    </Sheet>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <div className="hidden md:block w-72 shrink-0">
        <Sidebar />
      </div>
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-16 flex items-center px-6 border-b bg-card/50 backdrop-blur-sm sticky top-0 z-10 md:hidden">
          <MobileNav />
          <div className="ml-4 font-bold text-lg text-primary flex items-center gap-2">
            <Activity className="h-5 w-5" />
            <span>PocketPulse</span>
          </div>
        </header>
        <main className="flex-1 overflow-auto p-4 md:p-8">
          <div className="mx-auto max-w-6xl space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
