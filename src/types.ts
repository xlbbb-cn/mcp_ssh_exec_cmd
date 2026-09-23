/**
 * Shared types for the SSH MCP server.
 *
 * Kept in a single file so the storage layer, the SSH client wrapper
 * and the tool definitions can all reference the same shapes without
 * pulling in circular imports.
 */

/** Auth method for the SSH connection. */
export type AuthMethod = "password" | "pubkey";

/**
 * One host entry as held in memory / on disk.  Sensitive fields
 * (``ssh_password`` and ``ssh_private_key``) are stored as opaque
 * base64 ciphertexts; the storage layer encrypts on write and
 * decrypts on read.
 */
export interface HostRecord {
    /** Stable identifier (UUID v4 string). */
    id: string;
    ip_address: string;
    system_name: string;
    ssh_port: number;
    ssh_username: string;
    ssh_auth_method: AuthMethod;
    /** Encrypted (base64) password when auth_method=password. */
    ssh_password: string;
    /** Encrypted (base64) private key when auth_method=pubkey. */
    ssh_private_key: string;
    is_enable: boolean;
    created_at: string;
    updated_at: string;
}

/** Inputs accepted by the host create/update tools. */
export interface HostInput {
    ip_address: string;
    system_name?: string;
    ssh_port?: number;
    ssh_username?: string;
    ssh_auth_method?: AuthMethod;
    /** Plaintext password (will be encrypted at rest). */
    ssh_password?: string;
    /** Plaintext private key (will be encrypted at rest). */
    ssh_private_key?: string;
    is_enable?: boolean;
}

/**
 * Plaintext view of a host — what the SSH client actually consumes.
 *
 * Includes ``is_enable`` so the SSH tools can short-circuit disabled
 * hosts *before* opening a socket.  Does NOT include ``created_at`` /
 * ``updated_at`` because they are not useful to the SSH layer.
 */
export interface HostCreds {
    id: string;
    ip_address: string;
    system_name: string;
    ssh_port: number;
    ssh_username: string;
    ssh_auth_method: AuthMethod;
    ssh_password: string;
    ssh_private_key: string;
    is_enable: boolean;
}

/** Public-facing view of a host (no secrets). */
export interface HostPublic {
    id: string;
    ip_address: string;
    system_name: string;
    ssh_port: number;
    ssh_username: string;
    ssh_auth_method: AuthMethod;
    is_enable: boolean;
    created_at: string;
    updated_at: string;
}

/** Result of running a single command. */
export interface CommandResult {
    command: string;
    stdout: string;
    stderr: string;
    exit_code: number | null;
    success: boolean;
    duration_ms: number;
}

/** Single expect/answer pair for interactive commands. */
export interface ExpectAnswer {
    expect: string;
    answer: string;
}
