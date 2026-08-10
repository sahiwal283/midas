import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import { UploadRetryBanner } from './UploadRetryBanner';
import { NotificationBell } from './NotificationBell';
import { ExtensionSetupModal } from './ExtensionSetupModal';

export function Layout() {
  return (
    <div className="flex h-screen overflow-hidden bg-cream">
      <div className="hidden lg:flex">
        <Sidebar />
      </div>
      <div className="fixed right-2 top-2 z-30 lg:hidden">
        <NotificationBell align="right" direction="down" />
      </div>
      <main className="flex flex-1 flex-col overflow-y-auto pb-20 lg:pb-0">
        <UploadRetryBanner />
        <Outlet />
      </main>
      <MobileNav />
      <ExtensionSetupModal />
    </div>
  );
}
