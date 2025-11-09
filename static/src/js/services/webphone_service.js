/** @odoo-module **/

import { reactive } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { rpc as rpcRequest } from "@web/core/network/rpc";

const LOCAL_SIP_URL = "/phone/static/lib/sipjs/sip-0.21.2.min.js";
const CDN_SIP_URL = "https://cdn.jsdelivr.net/npm/sip.js@0.21.2/dist/sip.min.js";

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Unable to load sip.js from ${src}`));
        document.body.appendChild(script);
    });
}

registry.category("services").add("webphone", {
    dependencies: ["notification"],
    start(env, { notification }) {
        const state = reactive({
            panelOpen: false,
            minimized: false,
            loading: false,
            initialized: false,
            hasAccount: false,
            account: null,
            status: "offline",
            callStatus: "idle",
            dialNumber: "",
            incomingCaller: "",
            error: null,
            incomingRinging: false,
        });

        let sipLibraryPromise = null;
        let initPromise = null;
        let userAgent = null;
        let registerer = null;
        let currentSession = null;
        let pendingIncomingSession = null;
        let audioElement = null;

        const ensureSipLibrary = async () => {
            if (window.SIP) {
                return;
            }
            if (!sipLibraryPromise) {
                sipLibraryPromise = loadScript(LOCAL_SIP_URL).catch(() => loadScript(CDN_SIP_URL));
            }
            await sipLibraryPromise;
            if (!window.SIP) {
                throw new Error("sip.js did not load correctly. Check your network connection.");
            }
        };

        const stopUserAgent = async () => {
            if (currentSession) {
                try {
                    if (typeof currentSession.bye === "function") {
                        currentSession.bye();
                    } else if (typeof currentSession.cancel === "function") {
                        currentSession.cancel();
                    } else if (typeof currentSession.dispose === "function") {
                        currentSession.dispose();
                    }
                } catch (error) {
                    console.warn("Error terminating SIP session", error);
                }
                currentSession = null;
            }
            if (pendingIncomingSession) {
                try {
                    pendingIncomingSession.reject?.();
                } catch (error) {
                    console.warn("Error rejecting pending session", error);
                }
                pendingIncomingSession = null;
            }
            if (registerer) {
                try {
                    await registerer.unregister();
                } catch (error) {
                    console.warn("Error unregistering webphone", error);
                }
                registerer = null;
            }
            if (userAgent) {
                try {
                    await userAgent.stop();
                } catch (error) {
                    console.warn("Error stopping user agent", error);
                }
                userAgent = null;
            }
        };

        const attachRemoteStream = (sdh) => {
            if (!sdh || !audioElement) {
                return;
            }
            const play = () => {
                const remoteStream = sdh.remoteMediaStream;
                if (remoteStream) {
                    audioElement.srcObject = remoteStream;
                    audioElement.play().catch(() => {});
                }
            };
            if (sdh.on) {
                sdh.on("addTrack", play);
            }
            play();
        };

        const onCallTerminated = () => {
            currentSession = null;
            state.callStatus = "idle";
            state.incomingRinging = false;
        };

        const configureSession = (session) => {
            currentSession = session;
            const { SessionState } = window.SIP;
            session.delegate = Object.assign({}, session.delegate, {
                onBye: () => onCallTerminated(),
                onSessionDescriptionHandler: (sdh) => attachRemoteStream(sdh),
            });
            if (session.sessionDescriptionHandler) {
                attachRemoteStream(session.sessionDescriptionHandler);
            }
            session.stateChange.addListener((newState) => {
                if (newState === SessionState.Established) {
                    state.callStatus = "in_call";
                }
                if (newState === SessionState.Terminated) {
                    onCallTerminated();
                }
            });
        };

        const startUserAgent = async () => {
            if (!state.hasAccount) {
                return;
            }
            await stopUserAgent();
            const SIP = window.SIP;
            const account = state.account;
            const uri = SIP.UserAgent.makeURI(`sip:${account.auth_username}@${account.domain}`);
            if (!uri) {
                throw new Error("Invalid SIP URI, check your SIP domain/username.");
            }
            const configuration = {
                uri,
                authorizationUsername: account.auth_username,
                authorizationPassword: account.auth_password,
                displayName: account.user_display_name || account.extension || account.label,
                transportOptions: {
                    server: account.ws_uri,
                },
                sessionDescriptionHandlerFactoryOptions: {
                    peerConnectionConfiguration: {
                        iceServers: buildIceServers(account),
                    },
                },
                sessionDescriptionHandlerOptions: {
                    constraints: { audio: true, video: false },
                },
            };
            userAgent = new SIP.UserAgent(configuration);
            userAgent.delegate = {
                onConnect: () => {
                    state.status = "connected";
                },
                onDisconnect: () => {
                    state.status = "offline";
                },
                onInvite: (invitation) => handleIncomingInvitation(invitation),
            };
            await userAgent.start();
            registerer = new SIP.Registerer(userAgent);
            registerer.stateChange.addListener((newState) => {
                const { RegistererState } = SIP;
                if (newState === RegistererState.Registered) {
                    state.status = "registered";
                } else if (newState === RegistererState.Terminated) {
                    state.status = "offline";
                }
            });
            try {
                await registerer.register();
            } catch (error) {
                state.status = "registration_failed";
                throw error;
            }
        };

        const handleIncomingInvitation = (invitation) => {
            if (pendingIncomingSession) {
                invitation.reject();
                return;
            }
            pendingIncomingSession = invitation;
            state.callStatus = "incoming";
            state.incomingRinging = true;
            state.incomingCaller = formatRemoteParty(invitation.remoteIdentity);
            invitation.stateChange.addListener((newState) => {
                if (newState === window.SIP.SessionState.Terminated && pendingIncomingSession === invitation) {
                    pendingIncomingSession = null;
                    state.callStatus = "idle";
                    state.incomingRinging = false;
                }
            });
        };

        const ensureInitialized = async () => {
            if (state.initialized) {
                return;
            }
            if (initPromise) {
                return initPromise;
            }
            state.loading = true;
            state.error = null;
            initPromise = (async () => {
                try {
                    const result = await rpcRequest("/phone/webphone/config", {});
                    state.hasAccount = result.has_account;
                    state.account = result.account || null;
                    if (!state.hasAccount) {
                        state.status = "no_account";
                        return;
                    }
                    state.dialNumber = result.account.extension || "";
                    await ensureSipLibrary();
                    await startUserAgent();
                } catch (error) {
                    console.error("Webphone initialization error", error);
                    state.error = error.message || String(error);
                } finally {
                    state.initialized = true;
                    state.loading = false;
                }
            })();
            return initPromise;
        };

        const togglePanel = async () => {
            if (!state.panelOpen) {
                await ensureInitialized();
            }
            state.panelOpen = !state.panelOpen;
            if (!state.panelOpen) {
                state.minimized = false;
            }
        };

        const ensureReadyForCall = async () => {
            await ensureInitialized();
            if (!state.hasAccount) {
                notification.add(_t("You do not have an active SIP account."), { type: "warning" });
                return false;
            }
            if (!userAgent) {
                notification.add(_t("Webphone is not ready yet. Please retry in a few seconds."), {
                    type: "warning",
                });
                return false;
            }
            return true;
        };

        const placeCall = async () => {
            if (state.callStatus === "in_call" || state.callStatus === "dialing") {
                return;
            }
            const ready = await ensureReadyForCall();
            if (!ready) {
                return;
            }
            const target = (state.dialNumber || "").trim();
            if (!target) {
                notification.add(_t("Enter a destination number first."), { type: "warning" });
                return;
            }
            const SIP = window.SIP;
            const destination = SIP.UserAgent.makeURI(`sip:${target}@${state.account.domain}`);
            if (!destination) {
                notification.add(_t("The destination SIP URI is invalid."), { type: "danger" });
                return;
            }
            state.callStatus = "dialing";
            try {
                const inviter = new SIP.Inviter(userAgent, destination, {
                    sessionDescriptionHandlerOptions: {
                        constraints: { audio: true, video: false },
                    },
                });
                configureSession(inviter);
                await inviter.invite();
            } catch (error) {
                console.error("Error placing webphone call", error);
                notification.add(_t("Unable to place the call."), { type: "danger" });
                onCallTerminated();
            }
        };

        const callNumber = async (number) => {
            state.panelOpen = true;
            await ensureInitialized();
            if (!number) {
                return;
            }
            state.dialNumber = number;
            await placeCall();
        };

        const acceptIncoming = async () => {
            if (!pendingIncomingSession) {
                return;
            }
            const session = pendingIncomingSession;
            pendingIncomingSession = null;
            state.incomingRinging = false;
            state.callStatus = "connecting";
            configureSession(session);
            try {
                await session.accept({
                    sessionDescriptionHandlerOptions: {
                        constraints: { audio: true, video: false },
                    },
                });
            } catch (error) {
                console.error("Error accepting call", error);
                notification.add(_t("Unable to accept the call."), { type: "danger" });
                state.callStatus = "idle";
            }
        };

        const rejectIncoming = () => {
            if (!pendingIncomingSession) {
                return;
            }
            pendingIncomingSession.reject();
            pendingIncomingSession = null;
            state.callStatus = "idle";
            state.incomingRinging = false;
        };

        const hangup = () => {
            if (!currentSession) {
                rejectIncoming();
                return;
            }
            const { SessionState } = window.SIP;
            try {
                if (
                    currentSession.state === SessionState.Establishing &&
                    typeof currentSession.cancel === "function"
                ) {
                    currentSession.cancel();
                } else if (typeof currentSession.bye === "function") {
                    currentSession.bye();
                } else if (typeof currentSession.dispose === "function") {
                    currentSession.dispose();
                }
            } catch (error) {
                console.warn("Error hanging up call", error);
            }
        };

        const transferCall = async () => {
            if (!currentSession || state.callStatus !== "in_call") {
                notification.add(_t("You need to be in a call to transfer it."), { type: "warning" });
                return;
            }
            const target = (state.dialNumber || "").trim();
            if (!target) {
                notification.add(_t("Enter a destination number to transfer the call."), {
                    type: "warning",
                });
                return;
            }
            const SIP = window.SIP;
            const destination = SIP.UserAgent.makeURI(`sip:${target}@${state.account.domain}`);
            if (!destination) {
                notification.add(_t("The transfer destination is invalid."), { type: "danger" });
                return;
            }
            state.callStatus = "transferring";
            try {
                await currentSession.refer(destination);
                notification.add(_t("Transfer initiated."), { type: "success" });
            } catch (error) {
                console.error("Error transferring call", error);
                notification.add(_t("Unable to transfer the call."), { type: "danger" });
                state.callStatus = "in_call";
            }
        };

        const updateDialNumber = (value) => {
            state.dialNumber = value;
        };

        const appendDigit = (digit) => {
            state.dialNumber = (state.dialNumber || "") + digit;
        };

        const backspaceDigit = () => {
            state.dialNumber = (state.dialNumber || "").slice(0, -1);
        };

        const setAudioElement = (el) => {
            audioElement = el;
        };

        const closePanel = () => {
            state.panelOpen = false;
            state.minimized = false;
        };

        const toggleMinimized = () => {
            if (!state.panelOpen) {
                return;
            }
            state.minimized = !state.minimized;
        };

        window.addEventListener("beforeunload", () => {
            stopUserAgent();
        });

        return {
            state,
            togglePanel,
            closePanel,
            toggleMinimized,
            ensureInitialized,
            placeCall,
            callNumber,
            acceptIncoming,
            rejectIncoming,
            hangup,
            transferCall,
            updateDialNumber,
            appendDigit,
            backspaceDigit,
            setAudioElement,
        };
    },
});

function buildIceServers(account) {
    const servers = [];
    if (account.stun_server) {
        servers.push({ urls: account.stun_server });
    }
    if (account.turn_server) {
        const entry = { urls: account.turn_server };
        if (account.turn_username) {
            entry.username = account.turn_username;
        }
        if (account.turn_password) {
            entry.credential = account.turn_password;
        }
        servers.push(entry);
    }
    if (!servers.length) {
        servers.push({ urls: "stun:stun.l.google.com:19302" });
    }
    return servers;
}

function formatRemoteParty(identity) {
    if (!identity) {
        return "Unknown";
    }
    if (identity.displayName) {
        return identity.displayName;
    }
    if (identity.friendlyName) {
        return identity.friendlyName;
    }
    if (identity.uri && identity.uri.user) {
        return identity.uri.user;
    }
    return "Unknown";
}
