BEGIN;

-- 1. User roles
ALTER TABLE users
ADD COLUMN role VARCHAR(20)
NOT NULL DEFAULT 'user'
CHECK (role IN ('user', 'admin'));

-- 2. Hashed passwords
CREATE TABLE user_credentials (
    user_id UUID PRIMARY KEY
        REFERENCES users(id) ON DELETE RESTRICT,

    password_hash TEXT NOT NULL,

    password_changed_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
);

-- 3. Server-side sessions
CREATE TABLE user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,

    token_hash CHAR(64) NOT NULL UNIQUE,
    csrf_hash CHAR(64) NOT NULL,

    created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

    expires_at TIMESTAMPTZ NOT NULL,

    revoked_at TIMESTAMPTZ,

    CHECK (expires_at > created_at)
);

CREATE INDEX idx_sessions_user
ON user_sessions(user_id);

CREATE INDEX idx_sessions_expiry
ON user_sessions(expires_at)
WHERE revoked_at IS NULL;

-- 4. Optional session audit event index
CREATE INDEX idx_audit_actor_created
ON audit_events(actor_user_id, created_at DESC);

COMMIT;
