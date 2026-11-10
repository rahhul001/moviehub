# MovieHub

Movie links site: free download links, ₹10 pay-to-watch (Razorpay/UPI), and an admin panel.
Only list content you own, have licensed, or that is public domain / openly licensed.

## Run
    npm install
    cp .env.example .env     # set ADMIN_PASSWORD, SESSION_SECRET, Razorpay keys
    npm start                # http://localhost:3000   admin: /admin/login

Requires Node >= 22.13 (uses built-in node:sqlite). With no Razorpay keys it runs in DEMO mode (fake payment).

## Admin can control
- Add/edit/hide/delete movies, poster, download link, watch link
- Per-movie price or global price, access duration (hours), enable/disable payments, site name
- View all payments and revenue

## Go live checklist
- Strong ADMIN_PASSWORD and SESSION_SECRET, serve over HTTPS
- Add Razorpay keys (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)
