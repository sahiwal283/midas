import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import { UploadRetryBanner } from './UploadRetryBanner';

export function Layout() {
  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      {/* Desktop-only sidebar; phones get the bottom nav */}
      <div className="hidden lg:flex">
        <Sidebar />
      </div>
      <main className="flex flex-1 flex-col overflow-y-auto pb-20 lg:pb-0">
        <UploadRetryBanner />
        <Outlet />
      </main>
      <MobileNav />
    </div>
  );
}
