import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './contexts/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Layout } from './components/Layout';
import { UploadQueueProvider } from './components/UploadQueueProvider';
import { Login } from './pages/Login';
import { InviteAccept } from './pages/InviteAccept';
import { Dashboard } from './pages/Dashboard';
import { MyExpenses } from './pages/MyExpenses';
import { ExpenseNew } from './pages/ExpenseNew';
import { ExpenseDetail } from './pages/ExpenseDetail';
import { AccountantQueue } from './pages/AccountantQueue';
import { AccountantReview } from './pages/AccountantReview';
import { ToUpload } from './pages/ToUpload';
import { Admin } from './pages/Admin';
import { PartnerExpenses } from './pages/PartnerExpenses';
import { PurchaseOrderNew } from './pages/PurchaseOrderNew';
import { PurchaseOrderDetail } from './pages/PurchaseOrderDetail';
import { Reports } from './pages/Reports';
import { Cashbook } from './pages/Cashbook';
import { IntegrationHealth } from './pages/IntegrationHealth';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <UploadQueueProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/invite/:token" element={<InviteAccept />} />

            <Route
              element={
                <ProtectedRoute>
                  <Layout />
                </ProtectedRoute>
              }
            >
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/expenses" element={<MyExpenses />} />
              <Route path="/transactions/new" element={<Navigate to="/expenses/new" replace />} />
              <Route path="/transactions/po/new" element={<PurchaseOrderNew />} />
              <Route path="/transactions/:id" element={<PurchaseOrderDetail />} />
              <Route path="/expenses/new" element={<ExpenseNew />} />
              <Route path="/expenses/:id" element={<ExpenseDetail />} />
              {/* Setup now lives in a first-run modal — keep old bookmarks alive. */}
              <Route path="/get-extension" element={<Navigate to="/dashboard" replace />} />
              <Route path="/to-upload" element={<ToUpload />} />

              <Route
                path="/partner-expenses"
                element={
                  <ProtectedRoute roles={['partner', 'accountant', 'admin', 'developer']}>
                    <PartnerExpenses />
                  </ProtectedRoute>
                }
              />

              <Route
                path="/reports"
                element={
                  <ProtectedRoute roles={['accountant', 'admin', 'developer']}>
                    <Reports />
                  </ProtectedRoute>
                }
              />

              <Route
                path="/cashbook"
                element={
                  <ProtectedRoute roles={['accountant', 'admin', 'developer']}>
                    <Cashbook />
                  </ProtectedRoute>
                }
              />
              <Route path="/accountant" element={<Navigate to="/accountant/daily" replace />} />
              <Route
                path="/accountant/daily"
                element={
                  <ProtectedRoute roles={['accountant', 'admin']}>
                    <AccountantQueue key="daily" scope="daily" />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/accountant/events"
                element={
                  <ProtectedRoute roles={['accountant', 'admin']}>
                    <AccountantQueue key="events" scope="event" />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/accountant/:id"
                element={
                  <ProtectedRoute roles={['accountant', 'admin']}>
                    <AccountantReview />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/integration-health"
                element={
                  <ProtectedRoute roles={['admin']}>
                    <IntegrationHealth />
                  </ProtectedRoute>
                }
              />

              {/* Settings is role-scoped inside the page — any authenticated user. */}
              <Route path="/admin" element={<Admin />} />
              {/* Payment Methods now lives inside Settings — keep old links alive. */}
              <Route path="/payment-methods" element={<Navigate to="/admin" replace />} />
            </Route>

            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </BrowserRouter>
        </UploadQueueProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
