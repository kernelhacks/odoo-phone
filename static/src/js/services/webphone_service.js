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
            attendedActive: false,
            attendedReady: false,
            attendedNumber: "",
            attendedStatus: "idle",
            conferenceActive: false,
            holdActive: false,
            muted: false,
            callDuration: 0,
        });

        let sipLibraryPromise = null;
        let initPromise = null;
        let userAgent = null;
        let registerer = null;
        let currentSession = null;
        let pendingIncomingSession = null;
        let primaryAudioElement = null;
        let secondaryAudioElement = null;
        let attendedSession = null;
        let currentSessionOnHold = false;
        const localStreams = new Set();
        let localAudioMuted = false;
        let callTimerId = null;
        let callTimerStart = null;

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
            clearAttendedState({ hangupSession: true, resumeMain: false });
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
            currentSessionOnHold = false;
            state.holdActive = false;
            localStreams.clear();
            localAudioMuted = false;
            state.muted = false;
            stopCallTimer();
        };

        const attachRemoteStream = (sdh, { target = "primary" } = {}) => {
            if (!sdh) {
                return;
            }
            const element = target === "secondary" ? secondaryAudioElement : primaryAudioElement;
            if (!element) {
                return;
            }
            const play = () => {
                const remoteStream = sdh.remoteMediaStream;
                if (remoteStream) {
                    element.srcObject = remoteStream;
                    element.play().catch(() => {});
                }
                updateLocalStream(sdh);
            };
            if (sdh.on) {
                sdh.on("addTrack", play);
            }
            play();
        };

        const updateLocalStream = (sdh) => {
            if (!sdh) {
                return;
            }
            if (sdh.localMediaStream) {
                localStreams.add(sdh.localMediaStream);
            }
            for (const stream of localStreams) {
                stream.getAudioTracks().forEach((track) => {
                    track.enabled = !localAudioMuted;
                });
            }
        };

        const unregisterSessionStream = (session) => {
            const stream = session?.sessionDescriptionHandler?.localMediaStream;
            if (stream && localStreams.has(stream)) {
                localStreams.delete(stream);
            }
        };

        const startCallTimer = () => {
            if (callTimerId) {
                window.clearInterval(callTimerId);
            }
            callTimerStart = Date.now();
            state.callDuration = 0;
            callTimerId = window.setInterval(() => {
                if (!callTimerStart) {
                    return;
                }
                state.callDuration = Math.floor((Date.now() - callTimerStart) / 1000);
            }, 1000);
        };

        const stopCallTimer = () => {
            if (callTimerId) {
                window.clearInterval(callTimerId);
                callTimerId = null;
            }
            callTimerStart = null;
            state.callDuration = 0;
        };

        const setMuteState = (shouldMute) => {
            localAudioMuted = shouldMute;
            state.muted = shouldMute;
            for (const stream of localStreams) {
                stream.getAudioTracks().forEach((track) => {
                    track.enabled = !shouldMute;
                });
            }
        };

        const reattachCurrentSessionAudio = () => {
            if (currentSession?.sessionDescriptionHandler) {
                attachRemoteStream(currentSession.sessionDescriptionHandler);
            }
        };

        const setMainCallHold = async (shouldHold, { silent = false } = {}) => {
            if (!currentSession) {
                currentSessionOnHold = false;
                state.holdActive = false;
                return;
            }
            if (currentSessionOnHold === shouldHold) {
                state.holdActive = shouldHold;
                return;
            }
            if (typeof currentSession.invite !== "function") {
                if (!silent) {
                    notification.add(
                        _t("The current call cannot be renegotiated to manage hold state."),
                        { type: "danger" }
                    );
                }
                throw new Error("hold_not_supported");
            }
            const holdModifier = window.SIP?.Web?.holdModifier;
            if (shouldHold && !holdModifier) {
                if (!silent) {
                    notification.add(_t("Hold is not supported in this browser/webphone setup."), {
                        type: "danger",
                    });
                }
                throw new Error("hold_not_supported");
            }
            try {
                await currentSession.invite({
                    sessionDescriptionHandlerModifiers: shouldHold && holdModifier ? [holdModifier] : [],
                });
                currentSessionOnHold = shouldHold;
                state.holdActive = shouldHold;
                if (!shouldHold) {
                    reattachCurrentSessionAudio();
                }
            } catch (error) {
                console.error("Error toggling hold state", error);
                if (!silent) {
                    notification.add(
                        shouldHold
                            ? _t("Unable to place the caller on hold.")
                            : _t("Unable to resume the held caller."),
                        { type: "danger" }
                    );
                }
                throw error;
            }
        };

        const terminateAttendedSession = () => {
            if (!attendedSession) {
                return;
            }
            try {
                const SessionState = window.SIP?.SessionState;
                const isEstablishing =
                    SessionState && attendedSession.state === SessionState.Establishing;
                if (typeof attendedSession.bye === "function" && !isEstablishing) {
                    attendedSession.bye();
                } else if (typeof attendedSession.cancel === "function" && isEstablishing) {
                    attendedSession.cancel();
                } else if (typeof attendedSession.dispose === "function") {
                    attendedSession.dispose();
                }
            } catch (error) {
                console.warn("Error terminating attended transfer session", error);
            }
        };

        const clearAttendedState = ({ hangupSession = false, resumeMain = true } = {}) => {
            const sessionToClear = attendedSession;
            if (hangupSession) {
                terminateAttendedSession();
            }
            attendedSession = null;
            state.attendedActive = false;
            state.attendedReady = false;
            state.attendedNumber = "";
            state.attendedStatus = "idle";
            state.conferenceActive = false;
            if (["attended_consult", "attended_ready", "conference"].includes(state.callStatus)) {
                state.callStatus = currentSession ? "in_call" : "idle";
            }
            if (resumeMain) {
                setMainCallHold(false, { silent: true }).catch(() => {});
            }
            unregisterSessionStream(sessionToClear);
            if (secondaryAudioElement) {
                secondaryAudioElement.srcObject = null;
            }
            reattachCurrentSessionAudio();
        };

        const onCallTerminated = () => {
            unregisterSessionStream(currentSession);
            currentSession = null;
            state.callStatus = "idle";
            state.incomingRinging = false;
            currentSessionOnHold = false;
            state.holdActive = false;
            setMuteState(false);
            localStreams.clear();
            stopCallTimer();
            clearAttendedState({ hangupSession: true, resumeMain: false });
        };

        const configureSession = (session) => {
            currentSession = session;
            currentSessionOnHold = false;
            const { SessionState } = window.SIP;
            session.delegate = Object.assign({}, session.delegate, {
                onBye: () => onCallTerminated(),
                onSessionDescriptionHandler: (sdh) => attachRemoteStream(sdh, { target: "primary" }),
            });
            if (session.sessionDescriptionHandler) {
                attachRemoteStream(session.sessionDescriptionHandler, { target: "primary" });
            }
            session.stateChange.addListener((newState) => {
                if (newState === SessionState.Established) {
                    state.callStatus = "in_call";
                    if (!callTimerId) {
                        startCallTimer();
                    }
                }
                if (newState === SessionState.Terminated) {
                    onCallTerminated();
                }
            });
        };

        const configureAttendedSession = (session) => {
            const { SessionState } = window.SIP;
            session.delegate = Object.assign({}, session.delegate, {
                onBye: () => clearAttendedState(),
                onSessionDescriptionHandler: (sdh) => attachRemoteStream(sdh, { target: "secondary" }),
            });
            if (session.sessionDescriptionHandler) {
                attachRemoteStream(session.sessionDescriptionHandler, { target: "secondary" });
            }
            session.stateChange.addListener((newState) => {
                if (newState === SessionState.Established) {
                    state.attendedReady = true;
                    state.attendedStatus = "ready";
                    state.callStatus = "attended_ready";
                }
                if (newState === SessionState.Terminated) {
                    clearAttendedState();
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
            if (
                [
                    "in_call",
                    "dialing",
                    "attended_consult",
                    "attended_ready",
                    "attended_transferring",
                    "conference",
                ].includes(state.callStatus)
            ) {
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
            if (attendedSession) {
                clearAttendedState({ hangupSession: true, resumeMain: false });
            }
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
            if (!currentSession || !["in_call", "conference"].includes(state.callStatus)) {
                notification.add(_t("You need to be in a call to transfer it."), { type: "warning" });
                return;
            }
            if (state.attendedActive && !state.conferenceActive) {
                notification.add(_t("Finish or cancel the attended transfer first."), {
                    type: "warning",
                });
                return;
            }
            if (state.conferenceActive) {
                notification.add(_t("Transfer is disabled during a conference."), { type: "warning" });
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

        const toggleHold = async () => {
            if (!currentSession) {
                notification.add(_t("No active call to put on hold."), { type: "warning" });
                return;
            }
            if (state.attendedActive) {
                notification.add(_t("Cannot toggle hold while an attended transfer or conference is running."), {
                    type: "warning",
                });
                return;
            }
            const targetState = !state.holdActive;
            try {
                await setMainCallHold(targetState);
            } catch (_error) {
                // errors already notified inside helper when not silent
            }
        };

        const toggleMute = () => {
            if (!currentSession && !attendedSession) {
                notification.add(_t("No active audio session to mute."), { type: "warning" });
                return;
            }
            setMuteState(!state.muted);
        };

        const startConference = async () => {
            if (!currentSession || !attendedSession) {
                notification.add(_t("You need two active calls to start a conference."), {
                    type: "warning",
                });
                return;
            }
            if (!state.attendedReady) {
                notification.add(_t("Wait until the consult call is connected before conferencing."), {
                    type: "warning",
                });
                return;
            }
            if (state.conferenceActive) {
                return;
            }
            try {
                await setMainCallHold(false, { silent: true });
            } catch (_error) {
                notification.add(_t("Unable to resume the original caller for conferencing."), {
                    type: "danger",
                });
                return;
            }
            state.conferenceActive = true;
            state.callStatus = "conference";
            state.attendedStatus = "conference";
            state.holdActive = false;
            if (currentSession.sessionDescriptionHandler) {
                attachRemoteStream(currentSession.sessionDescriptionHandler, { target: "primary" });
            }
            if (attendedSession.sessionDescriptionHandler) {
                attachRemoteStream(attendedSession.sessionDescriptionHandler, { target: "secondary" });
            }
        };

        const endConference = () => {
            if (!state.conferenceActive) {
                return;
            }
            clearAttendedState({ hangupSession: true });
            state.conferenceActive = false;
            notification.add(_t("Conference ended."), { type: "info" });
        };

        const startAttendedTransfer = async () => {
            if (!currentSession || state.callStatus !== "in_call") {
                notification.add(_t("You need to be in a call to start an attended transfer."), {
                    type: "warning",
                });
                return;
            }
            if (attendedSession) {
                notification.add(_t("An attended transfer is already in progress."), {
                    type: "warning",
                });
                return;
            }
            if (!userAgent) {
                notification.add(_t("Webphone is not ready for an attended transfer yet."), {
                    type: "warning",
                });
                return;
            }
            const target = (state.dialNumber || "").trim();
            if (!target) {
                notification.add(_t("Enter a destination number to consult before transferring."), {
                    type: "warning",
                });
                return;
            }
            const SIP = window.SIP;
            const destination = SIP.UserAgent.makeURI(`sip:${target}@${state.account.domain}`);
            if (!destination) {
                notification.add(_t("The consult destination is invalid."), { type: "danger" });
                return;
            }
            try {
                await setMainCallHold(true, { silent: true });
            } catch (error) {
                return;
            }
            state.attendedActive = true;
            state.attendedReady = false;
            state.attendedNumber = target;
            state.attendedStatus = "consulting";
            state.callStatus = "attended_consult";
            state.conferenceActive = false;
            try {
                const inviter = new SIP.Inviter(userAgent, destination, {
                    sessionDescriptionHandlerOptions: {
                        constraints: { audio: true, video: false },
                    },
                });
                attendedSession = inviter;
                configureAttendedSession(inviter);
                await inviter.invite();
            } catch (error) {
                console.error("Error starting attended transfer", error);
                notification.add(_t("Unable to start the attended transfer."), { type: "danger" });
                clearAttendedState({ hangupSession: true });
                state.callStatus = currentSession ? "in_call" : "idle";
            }
        };

        const completeAttendedTransfer = async () => {
            if (!currentSession || !attendedSession) {
                notification.add(_t("No attended transfer is currently in progress."), {
                    type: "warning",
                });
                return;
            }
            if (state.conferenceActive) {
                notification.add(_t("Cannot transfer while a conference is active."), {
                    type: "warning",
                });
                return;
            }
            if (!state.attendedReady) {
                notification.add(_t("Wait until the consult call is connected before transferring."), {
                    type: "warning",
                });
                return;
            }
            state.attendedStatus = "transferring";
            state.callStatus = "attended_transferring";
            try {
                await currentSession.refer(attendedSession);
                notification.add(_t("Attended transfer initiated."), { type: "success" });
                clearAttendedState({ hangupSession: true, resumeMain: false });
                hangup();
            } catch (error) {
                console.error("Error completing attended transfer", error);
                notification.add(_t("Unable to complete the attended transfer."), {
                    type: "danger",
                });
                state.attendedStatus = "ready";
                state.callStatus = "attended_ready";
            }
        };

        const cancelAttendedTransfer = () => {
            if (!attendedSession && !state.attendedActive) {
                return;
            }
            const wasConference = state.conferenceActive;
            clearAttendedState({ hangupSession: true });
            notification.add(
                wasConference ? _t("Conference ended.") : _t("Attended transfer cancelled."),
                { type: "info" }
            );
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

        const setAudioElements = (primaryEl, secondaryEl) => {
            primaryAudioElement = primaryEl;
            secondaryAudioElement = secondaryEl;
            reattachCurrentSessionAudio();
            if (attendedSession?.sessionDescriptionHandler) {
                attachRemoteStream(attendedSession.sessionDescriptionHandler, { target: "secondary" });
            }
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
            toggleHold,
            toggleMute,
            startConference,
            endConference,
            startAttendedTransfer,
            completeAttendedTransfer,
            cancelAttendedTransfer,
            updateDialNumber,
            appendDigit,
            backspaceDigit,
            setAudioElements,
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
