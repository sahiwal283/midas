/**
 * Active-state for the Accountant sidebar links.
 *
 * Three links share the `/accountant` pathname space, which NavLink's own
 * matching cannot separate:
 *   Review Queue    /accountant
 *   Purchase Orders /accountant/purchase-orders
 *   Reimbursements  /accountant?reimbursementStatus=pending
 *
 * NavLink matches on pathname and treats descendants as active, and it ignores
 * the query string entirely — so on /accountant/purchase-orders both Review
 * Queue and Reimbursements also lit up, and on /accountant Review Queue and
 * Reimbursements lit up together.
 *
 * Review Queue stays active for an expense detail page (/accountant/:id)
 * because that is still inside the queue, but not for Purchase Orders, which
 * is its own destination.
 */
export interface NavLocation {
  pathname: string;
  search: string;
}

const PURCHASE_ORDERS = '/accountant/purchase-orders';

export function accountantNavActive(location: NavLocation): {
  reviewQueue: boolean;
  purchaseOrders: boolean;
  reimbursements: boolean;
} {
  const { pathname } = location;
  const atRoot = pathname === '/accountant';
  const purchaseOrders = pathname === PURCHASE_ORDERS;

  const reimbursements =
    atRoot && new URLSearchParams(location.search).get('reimbursementStatus') === 'pending';

  // Expense detail pages live under /accountant/<id> and belong to the queue.
  const inQueueDetail = pathname.startsWith('/accountant/') && !purchaseOrders;

  return {
    reviewQueue: (atRoot && !reimbursements) || inQueueDetail,
    purchaseOrders,
    reimbursements,
  };
}
