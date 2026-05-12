# Security Specification - Zero-Trust Firestore Rules

## 1. Data Invariants
- A `Purchase` cannot exist without a valid `userId` (the buyer) and a valid `botId`.
- Access to `ChatMessage` is strictly bound to the membership of the parent `SupportChat`.
- `AuditLog` is immutable and only accessible by admins.
- User `role` can only be changed by a `Founder` or an `Admin` (with restrictions).
- Terminal states (e.g., `Purchase.status == 'completed'`) cannot be reverted.

## 2. The "Dirty Dozen" Payloads (Malicious Attempts)

1.  **Identity Spoofing**: Attempt to create a `Purchase` for another user ID.
    ```json
    { "userId": "victim_uid", "botId": "bot_123", "status": "completed" }
    ```
2.  **Privilege Escalation**: Attempt to update own user profile to `role: 'founder'`.
    ```json
    { "role": "founder" }
    ```
3.  **Shadow Field Injection**: Attempt to inject a field `isAdmin: true` into a `User` profile.
    ```json
    { "displayName": "Attacker", "isAdmin": true }
    ```
4.  **Resource Poisoning (ID)**: Attempt to use a 1MB string as a `botId` in a rating.
    ```json
    { "botId": "A".repeat(1024 * 1024), "rating": 5 }
    ```
5.  **Denial of Wallet (String Bloat)**: Sending a `Notification` with a 1MB message.
    ```json
    { "userId": "my_uid", "message": "A".repeat(1000000), "title": "Spam" }
    ```
6.  **Terminal State Reversal**: Trying to change a `Purchase` status from `completed` back to `trial`.
    ```json
    { "status": "trial" }
    ```
7.  **Orphaned Record**: Creating a `Rating` for a `botId` that does not exist.
    ```json
    { "userId": "my_uid", "botId": "NON_EXISTENT_ID", "rating": 5 }
    ```
8.  **Query Scraper (Blanket List)**: Attempting to `list` all users without a filter.
    ```javascript
    db.collection('users').get() // Should be rejected if no admin role
    ```
9.  **Relational Leak (Chat)**: Accessing `/support_chats/victim_chat/messages` as a different user.
10. **Immutable Field Ghosting**: Attempting to change `createdAt` on a `Notification` during update.
11. **Action-Gate Bypass**: Attempting to update `WorkflowTask` status AND title simultaneously as a non-admin.
12. **PII Blanket Read**: Authenticated user trying to `get` another user's PII (like private emails if we had them).

## 3. Test Runner (Draft)
A `firestore.rules.test.ts` will be implemented to verify these rejections.
