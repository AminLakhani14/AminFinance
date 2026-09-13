import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { AuthGate } from "@/features/auth/AuthGate";
import { Dashboard } from "@/pages/Dashboard";

/**
 * Every route except the Dashboard is split out.
 *
 * Doing this now, while the pages are near-empty, means the boundaries already
 * exist when they get heavy — Analytics pulls in charting, News pulls in the AI
 * views, and Phase 6 adds a ~600kb Three.js scene. Retrofitting splits after
 * that is how initial bundles quietly triple.
 *
 * Dashboard stays eager: it is the landing route, so lazy-loading it would only
 * add a network round trip before first paint.
 */
const Portfolio = lazy(() =>
  import("@/pages/Portfolio").then((m) => ({ default: m.Portfolio })),
);
const Analytics = lazy(() =>
  import("@/pages/Analytics").then((m) => ({ default: m.Analytics })),
);
const News = lazy(() =>
  import("@/pages/News").then((m) => ({ default: m.News })),
);
const Suggestions = lazy(() =>
  import("@/pages/Suggestions").then((m) => ({ default: m.Suggestions })),
);
const Market = lazy(() =>
  import("@/pages/Market").then((m) => ({ default: m.Market })),
);
const MonthlyExpense = lazy(() =>
  import("@/pages/MonthlyExpense").then((m) => ({ default: m.MonthlyExpense })),
);
const Settings = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.Settings })),
);
const AssetDetail = lazy(() =>
  import("@/pages/AssetDetail").then((m) => ({ default: m.AssetDetail })),
);
const NotFound = lazy(() =>
  import("@/pages/NotFound").then((m) => ({ default: m.NotFound })),
);

/** Height-matched to a typical page header so the swap doesn't jolt layout. */
function RouteFallback() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="h-7 w-40 animate-pulse rounded-md bg-surface-raised" />
      <div className="h-64 animate-pulse rounded-card bg-surface-raised" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function App() {
  return (
    <AuthGate>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Dashboard />} />
            <Route
              path="portfolio"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <Portfolio />
                </Suspense>
              }
            />
            <Route
              path="expenses"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <MonthlyExpense />
                </Suspense>
              }
            />
            <Route
              path="analytics"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <Analytics />
                </Suspense>
              }
            />
            <Route
              path="market"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <Market />
                </Suspense>
              }
            />
            <Route
              path="suggestions"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <Suggestions />
                </Suspense>
              }
            />
            <Route
              path="news"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <News />
                </Suspense>
              }
            />
            <Route
              path="asset/:symbol"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <AssetDetail />
                </Suspense>
              }
            />
            <Route
              path="settings"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <Settings />
                </Suspense>
              }
            />
            <Route
              path="*"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <NotFound />
                </Suspense>
              }
            />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthGate>
  );
}
