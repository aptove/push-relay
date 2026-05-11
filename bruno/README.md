# Push Relay API - Bruno Collection

This Bruno collection contains all the API endpoints for the Push Relay service.

## Setup

1. **Install Bruno**: Download from [usebruno.com](https://www.usebruno.com/)
2. **Open Collection**: File → Open Collection → Select this `bruno` folder
3. **Configure Environment**:
   - Select **Local** environment for local development
   - Select **Production** environment for deployed worker
   - Update environment variables with your actual values:
     - `access_token`: Bearer JWT obtained from cf-token (see "Obtaining a JWT" below)
     - `device_token_ios`: APNs device token from iOS device
     - `device_token_android`: FCM device token from Android device

## Environment Variables

### Local Environment
- `base_url`: `http://localhost:8787` (use `npm run dev` to start)
- For local development with actual push notifications, you'll need to set up `.dev.vars` file

### Production Environment
- `base_url`: `https://push.aptove.com` (or your custom domain)

## API Endpoints

1. **Health Check** - Verify the relay is running
2. **Register iOS Device** - Register an iOS device for push notifications
3. **Register Android Device** - Register an Android device for push notifications
4. **Unregister Device** - Remove a device from push notifications
5. **Send Push Notification** - Send notification to all registered devices

## Testing Flow

1. Start with **Health Check** to verify connectivity
2. **Register** one or more devices (iOS/Android)
3. **Send Push Notification** to test delivery
4. **Unregister** devices when no longer needed

## Notes

- All API requests (except Health Check) require `Authorization: Bearer <access_token>` — each `.bru` file includes this header via `{{access_token}}`
- JWTs are issued by cf-token and expire after 1 hour — re-fetch when expired
- Device tokens are isolated per JWT identity (bridge `client_id`) — devices registered with one bridge cannot receive pushes from another
- The worker automatically handles APNs JWT and FCM OAuth2 token refresh via cron

## Collecting Tokens for Testing

### 1. Obtaining a JWT (access_token)

JWTs are issued by cf-token. Bridges automatically fetch them using their `client_id` and `client_secret` from `common.toml`. For manual testing, you can fetch one directly:

```bash
curl -s -X POST https://token.aptove.com/token \
  -H "Content-Type: application/json" \
  -d '{"client_id": "<your-bridge-client-id>", "client_secret": "<your-bridge-client-secret>"}' \
  | jq -r .access_token
```

The token expires in 1 hour. Paste the value into the `access_token` Bruno environment variable.

> **Bridge client credentials** are stored in `common.toml` under `[push_relay]` → `client_id` and `client_secret`. These are created once via `POST token.aptove.com/clients` with an admin JWT (see `cf-token/README.md`).

### 2. iOS Device Token (APNs)

**Debug builds automatically print the token:**
- Run the iOS app in Xcode (Debug configuration)
- Check console for: `"🔐 BRUNO TOKEN - iOS APNs: <token>"`
- Copy the full token string

**Production builds** do NOT print tokens for security.

### 3. Android Device Token (FCM)

**Debug builds automatically print the token:**
- Run the Android app in Android Studio (Debug build variant)
- Check Logcat for: `"🔐 BRUNO TOKEN - Android FCM: <token>"`
- Copy the full token string

**Alternatively, filter logcat:**
```bash
adb logcat | grep "BRUNO TOKEN"
```

**Production/Release builds** do NOT print tokens for security.

### 4. Update Bruno Environment

Once you have the tokens:
1. Open Bruno
2. Select **Environments** → **Production** (or Local)
3. Update variables:
   ```
   access_token: <paste_jwt_from_cf_token>
   device_token_ios: <paste_ios_apns_token>
   device_token_android: <paste_android_fcm_token>
   ```
4. Save the environment

### Quick Test

1. **Fetch a JWT** using your bridge's `client_id`/`client_secret` (see step 1 above)
2. **Run mobile app** (iOS or Android) in debug mode
3. **Copy device token** from console/logcat
4. **Open Bruno** and update environment variables
5. **Test**: Send "Register iOS Device" or "Register Android Device"
6. **Verify**: Send "Send Push Notification" and check device receives it
