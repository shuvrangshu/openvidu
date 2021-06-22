/*
 * (C) Copyright 2017-2020 OpenVidu (https://openvidu.io)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import freeice = require('freeice');
import { v4 as uuidv4 } from 'uuid';
import { ExceptionEventName } from '../Events/ExceptionEvent';
import { OpenViduLogger } from '../Logger/OpenViduLogger';
import { PlatformUtils } from '../Utils/Platform';

/**
 * @hidden
 */
const logger: OpenViduLogger = OpenViduLogger.getInstance();
/**
 * @hidden
 */
let platform: PlatformUtils;

/*
 * Table of sender video encodings for simulcast.
 * Note that this is just a polite request, but the browser is free to honor it
 * or just play by its own rules.
 *
 * Chrome imposes some restrictions based on the size of the video, max bitrate,
 * and available bandwidth. Check here for the video size table:
 * https://chromium.googlesource.com/external/webrtc/+/master/media/engine/simulcast.cc#90
 *
 * | Size (px) | Bitrate (kbps) | Max Layers |
 * |----------:|---------------:|-----------:|
 * | 1920x1080 |           5000 |          3 |
 * |  1280x720 |           2500 |          3 |
 * |   960x540 |           1200 |          3 |
 * |   640x360 |            700 |          2 |
 * |   480x270 |            450 |          2 |
 * |   320x180 |            200 |          1 |
 */
const simulcastVideoEncodings: RTCRtpEncodingParameters[] = [
    {
        rid: "r0",
        maxBitrate: 700000,

        // TODO: Remove for final version; leave the browser decide:
        // https://w3c.github.io/webrtc-pc/#dom-rtcpeerconnection-addtransceiver
        // > If the scaleResolutionDownBy attribues of sendEncodings are still
        // > undefined, initialize each encoding's scaleResolutionDownBy to
        // > 2^(length of sendEncodings - encoding index - 1). This results in
        // > smaller-to-larger resolutions where the last encoding has no scaling
        // > applied to it, e.g. 4:2:1 if the length is 3.
        scaleResolutionDownBy: 16,
    },
    {
        rid: "r1",
        maxBitrate: 800000,
        scaleResolutionDownBy: 8,
    },
    {
        rid: "r2",
        maxBitrate: 900000,
        scaleResolutionDownBy: 1,
    },
];

export interface WebRtcPeerConfiguration {
    mediaConstraints: {
        audio: boolean,
        video: boolean
    };
    simulcast: boolean;
    onIceCandidate: (event: RTCIceCandidate) => void;
    onIceConnectionStateException: (exceptionName: ExceptionEventName, message: string, data?: any) => void;

    iceServers?: RTCIceServer[];
    mediaStream?: MediaStream | null;
    mode?: 'sendonly' | 'recvonly' | 'sendrecv';
    id?: string;
}

export class WebRtcPeer {
    pc: RTCPeerConnection;
    remoteCandidatesQueue: RTCIceCandidate[] = [];
    localCandidatesQueue: RTCIceCandidate[] = [];

    // Same as WebRtcPeerConfiguration but without optional fields.
    protected configuration: Required<WebRtcPeerConfiguration>;

    private iceCandidateList: RTCIceCandidate[] = [];
    private candidategatheringdone = false;

    constructor(configuration: WebRtcPeerConfiguration) {
        platform = PlatformUtils.getInstance();

        this.configuration = {
            ...configuration,
            iceServers:
                !!configuration.iceServers &&
                configuration.iceServers.length > 0
                    ? configuration.iceServers
                    : freeice(),
            mediaStream:
                configuration.mediaStream !== undefined
                    ? configuration.mediaStream
                    : null,
            mode: !!configuration.mode ? configuration.mode : "sendrecv",
            id: !!configuration.id ? configuration.id : this.generateUniqueId(),
        };

        this.pc = new RTCPeerConnection({ iceServers: this.configuration.iceServers });

        this.pc.addEventListener('icecandidate', (event: RTCPeerConnectionIceEvent) => {
            if (event.candidate != null) {
                const candidate: RTCIceCandidate = event.candidate;
                this.configuration.onIceCandidate(candidate);
                if (candidate.candidate !== '') {
                    this.localCandidatesQueue.push(<RTCIceCandidate>{ candidate: candidate.candidate });
                }
            }
        });

        this.pc.addEventListener('signalingstatechange', () => {
            if (this.pc.signalingState === 'stable') {
                while (this.iceCandidateList.length > 0) {
                    let candidate = this.iceCandidateList.shift();
                    this.pc.addIceCandidate(<RTCIceCandidate>candidate);
                }
            }
        });
    }

    getId(): string {
        return this.configuration.id;
    }

    /**
     * This method frees the resources used by WebRtcPeer
     */
    dispose() {
        logger.debug('Disposing WebRtcPeer');
        if (this.pc) {
            if (this.pc.signalingState === 'closed') {
                return;
            }
            this.pc.close();
            this.remoteCandidatesQueue = [];
            this.localCandidatesQueue = [];
        }
    }

    /**
     * Creates an SDP offer from the local RTCPeerConnection to send to the other peer
     * Only if the negotiation was initiated by this peer
     */
    createOffer(): Promise<RTCSessionDescriptionInit> {
        return new Promise((resolve, reject) => {
            // TODO: Delete this conditional when all supported browsers are
            // modern enough to implement the Transceiver methods.
            if ("addTransceiver" in this.pc) {
                logger.debug("[createOffer] Method RTCPeerConnection.addTransceiver() is available; using it");

                // Spec doc: https://w3c.github.io/webrtc-pc/#dom-rtcpeerconnection-addtransceiver

                if (this.configuration.mode !== "recvonly") {
                    // To send media, assume that all desired media tracks
                    // have been already added by higher level code to our
                    // MediaStream.

                    if (!this.configuration.mediaStream) {
                        reject(new Error(`${this.configuration.mode} direction requested, but no stream was configured to be sent`));
                        return;
                    }

                    for (const track of this.configuration.mediaStream.getTracks()) {
                        const tcInit: RTCRtpTransceiverInit = {
                            direction: this.configuration.mode,
                            streams: [this.configuration.mediaStream],
                        };

                        if (track.kind === "video") {
                            tcInit.sendEncodings = simulcastVideoEncodings;
                        }

                        this.pc.addTransceiver(track, tcInit);
                    }
                } else {
                    // To just receive media, create new recvonly transceivers.
                    for (const kind of ["audio", "video"]) {
                        // Check if the media kind should be used.
                        if (!this.configuration.mediaConstraints[kind]) {
                            continue;
                        }

                        this.configuration.mediaStream = new MediaStream();
                        this.pc.addTransceiver(kind, {
                            direction: this.configuration.mode,
                            streams: [this.configuration.mediaStream],
                        });
                    }
                }

                this.pc
                    .createOffer()
                    .then((sdpOffer) => resolve(sdpOffer))
                    .catch((error) => reject(error));
            } else {
                logger.error("[createOffer] Method RTCPeerConnection.addTransceiver() is NOT available; using LEGACY offerToReceive{Audio,Video}");

                // DEPRECATED LEGACY METHOD: Old WebRTC versions don't implement
                // Transceivers, and instead depend on the deprecated
                // "offerToReceiveAudio" and "offerToReceiveVideo".

                if (!!this.configuration.mediaStream) {
                    for (const track of this.configuration.mediaStream.getTracks()) {
                        // @ts-ignore - Compiler is too clever and thinks this branch will never execute.
                        this.pc.addTrack(track, this.configuration.mediaStream);
                    }
                }

                const hasAudio = this.configuration.mediaConstraints.audio;
                const hasVideo = this.configuration.mediaConstraints.video;

                const options: RTCOfferOptions = {
                    offerToReceiveAudio:
                        this.configuration.mode !== "sendonly" && hasAudio,
                    offerToReceiveVideo:
                        this.configuration.mode !== "sendonly" && hasVideo,
                };

                logger.debug("RTCPeerConnection.createOffer() options:", JSON.stringify(options));

                this.pc
                    // @ts-ignore - Compiler is too clever and thinks this branch will never execute.
                    .createOffer(options)
                    .then((sdpOffer) => resolve(sdpOffer))
                    .catch((error) => reject(error));
            }
        });
    }

    /**
     * Creates an SDP answer from the local RTCPeerConnection to send to the other peer
     * Only if the negotiation was initiated by the other peer
     */
    createAnswer(): Promise<RTCSessionDescriptionInit> {
        return new Promise((resolve, reject) => {
            // TODO: Delete this conditional when all supported browsers are
            // modern enough to implement the Transceiver methods.
            if ("getTransceivers" in this.pc) {
                logger.debug("[createAnswer] Method RTCPeerConnection.getTransceivers() is available; using it");

                // Ensure that the PeerConnection already contains one Transceiver
                // for each kind of media.
                // The Transceivers should have been already created internally by
                // the PC itself, when `pc.setRemoteDescription(sdpOffer)` was called.

                for (const kind of ["audio", "video"]) {
                    // Check if the media kind should be used.
                    if (!this.configuration.mediaConstraints[kind]) {
                        continue;
                    }

                    let tc = this.pc
                        .getTransceivers()
                        .find((tc) => tc.receiver.track.kind === kind);

                    if (tc) {
                        // Enforce our desired direction.
                        tc.direction = this.configuration.mode;
                    } else {
                        reject(new Error(`${kind} requested, but no transceiver was created from remote description`));
                    }
                }

                this.pc
                    .createAnswer()
                    .then((sdpAnswer) => resolve(sdpAnswer))
                    .catch((error) => reject(error));
            }

            // else, there is nothing to do; the legacy createAnswer() options do
            // not offer any control over which tracks are included in the answer.
        });
    }

    /**
     * This peer initiated negotiation. Step 1/4 of SDP offer-answer protocol
     */
    processLocalOffer(offer: RTCSessionDescriptionInit): Promise<void> {
        return new Promise((resolve, reject) => {
            this.pc.setLocalDescription(offer)
                .then(() => {
                    const localDescription = this.pc.localDescription;
                    if (!!localDescription) {
                        logger.debug('Local description set', localDescription.sdp);
                        resolve();
                    } else {
                        reject('Local description is not defined');
                    }
                })
                .catch(error => {
                    reject(error);
                });
        });
    }

    /**
     * Other peer initiated negotiation. Step 2/4 of SDP offer-answer protocol
     */
    processRemoteOffer(sdpOffer: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const offer: RTCSessionDescriptionInit = {
                type: 'offer',
                sdp: sdpOffer
            };
            logger.debug('SDP offer received, setting remote description', offer);

            if (this.pc.signalingState === 'closed') {
                reject('RTCPeerConnection is closed when trying to set remote description');
            }
            this.setRemoteDescription(offer)
                .then(() => {
                    resolve();
                })
                .catch(error => {
                    reject(error);
                });
        });
    }

    /**
     * Other peer initiated negotiation. Step 3/4 of SDP offer-answer protocol
     */
    processLocalAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
        return new Promise((resolve, reject) => {
            logger.debug('SDP answer created, setting local description');
            if (this.pc.signalingState === 'closed') {
                reject('RTCPeerConnection is closed when trying to set local description');
            }
            this.pc.setLocalDescription(answer)
                .then(() => resolve())
                .catch(error => reject(error));
        });
    }

    /**
     * This peer initiated negotiation. Step 4/4 of SDP offer-answer protocol
     */
    processRemoteAnswer(sdpAnswer: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const answer: RTCSessionDescriptionInit = {
                type: 'answer',
                sdp: sdpAnswer
            };
            logger.debug('SDP answer received, setting remote description');

            if (this.pc.signalingState === 'closed') {
                reject('RTCPeerConnection is closed when trying to set remote description');
            }
            this.setRemoteDescription(answer)
                .then(() => resolve())
                .catch(error => reject(error));
        });
    }

    /**
     * @hidden
     */
    async setRemoteDescription(sdp: RTCSessionDescriptionInit): Promise<void> {
        return this.pc.setRemoteDescription(sdp);
    }

    /**
     * Callback function invoked when an ICE candidate is received
     */
    addIceCandidate(iceCandidate: RTCIceCandidate): Promise<void> {
        return new Promise((resolve, reject) => {
            logger.debug('Remote ICE candidate received', iceCandidate);
            this.remoteCandidatesQueue.push(iceCandidate);
            switch (this.pc.signalingState) {
                case 'closed':
                    reject(new Error('PeerConnection object is closed'));
                    break;
                case 'stable':
                    if (!!this.pc.remoteDescription) {
                        this.pc.addIceCandidate(iceCandidate).then(() => resolve()).catch(error => reject(error));
                    } else {
                        this.iceCandidateList.push(iceCandidate);
                        resolve();
                    }
                    break;
                default:
                    this.iceCandidateList.push(iceCandidate);
                    resolve();
            }
        });
    }

    addIceConnectionStateChangeListener(otherId: string) {
        this.pc.addEventListener('iceconnectionstatechange', () => {
            const iceConnectionState: RTCIceConnectionState = this.pc.iceConnectionState;
            switch (iceConnectionState) {
                case 'disconnected':
                    // Possible network disconnection
                    const msg1 = 'IceConnectionState of RTCPeerConnection ' + this.configuration.id + ' (' + otherId + ') change to "disconnected". Possible network disconnection';
                    logger.warn(msg1);
                    this.configuration.onIceConnectionStateException(ExceptionEventName.ICE_CONNECTION_DISCONNECTED, msg1);
                    break;
                case 'failed':
                    const msg2 = 'IceConnectionState of RTCPeerConnection ' + this.configuration.id + ' (' + otherId + ') to "failed"';
                    logger.error(msg2);
                    this.configuration.onIceConnectionStateException(ExceptionEventName.ICE_CONNECTION_FAILED, msg2);
                    break;
                case 'closed':
                    logger.log('IceConnectionState of RTCPeerConnection ' + this.configuration.id + ' (' + otherId + ') change to "closed"');
                    break;
                case 'new':
                    logger.log('IceConnectionState of RTCPeerConnection ' + this.configuration.id + ' (' + otherId + ') change to "new"');
                    break;
                case 'checking':
                    logger.log('IceConnectionState of RTCPeerConnection ' + this.configuration.id + ' (' + otherId + ') change to "checking"');
                    break;
                case 'connected':
                    logger.log('IceConnectionState of RTCPeerConnection ' + this.configuration.id + ' (' + otherId + ') change to "connected"');
                    break;
                case 'completed':
                    logger.log('IceConnectionState of RTCPeerConnection ' + this.configuration.id + ' (' + otherId + ') change to "completed"');
                    break;
            }
        });
    }

    /**
     * @hidden
     */
    generateUniqueId(): string {
        return uuidv4();
    }

}


export class WebRtcPeerRecvonly extends WebRtcPeer {
    constructor(configuration: WebRtcPeerConfiguration) {
        configuration.mode = 'recvonly';
        super(configuration);
    }
}

export class WebRtcPeerSendonly extends WebRtcPeer {
    constructor(configuration: WebRtcPeerConfiguration) {
        configuration.mode = 'sendonly';
        super(configuration);
    }
}

export class WebRtcPeerSendrecv extends WebRtcPeer {
    constructor(configuration: WebRtcPeerConfiguration) {
        configuration.mode = 'sendrecv';
        super(configuration);
    }
}
