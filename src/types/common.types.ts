export interface ApiResponse<T = any> {
    success: boolean;
    message: string;
    data?: T;
    error?: string;
    requestId?: string;
}

export interface AuthenticatedUser {
    uid: string;
    email?: string;
    name?: string;
}
