import axios from 'axios';

// Tokens are stored in httpOnly cookies — no localStorage.
// All requests must include credentials so the browser sends the cookie.
const client = axios.create({
  baseURL: '/api/v1',
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

client.interceptors.response.use(
  (res) => res,
  (err) => {
    // Only redirect to /login from non-login pages to prevent infinite reload loop.
    // The login page itself calls /auth/me on mount (which returns 401 when
    // unauthenticated), so we must not redirect when already there.
    if (err.response?.status === 401 && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    return Promise.reject(err);
  },
);

export default client;
