import * as moniker from "moniker";
import { Provider } from "nconf";
import * as winston from "winston";
import * as api from "../api";
import * as core from "../core";
import * as shared from "../shared";
import * as socketStorage from "../socket-storage";
import * as utils from "../utils";
import * as storage from "./storage";

export function register(
    webSocketServer: core.IWebSocketServer,
    config: Provider,
    mongoManager: utils.MongoManager,
    producer: utils.kafkaProducer.IProducer,
    documentsCollectionName: string,
    metricClientConfig: any) {

    const throughput = new utils.ThroughputCounter(winston.info);
    const metricLogger = shared.createMetricClient(metricClientConfig);

    webSocketServer.on("connection", (socket: core.IWebSocket) => {
        const connectionProfiler = winston.startTimer();
        connectionProfiler.logger.info(`New socket.io connection`);

        // Map from client IDs on this connection to the object ID for them
        const connectionsMap: { [clientId: string]: string } = {};

        function sendAndTrack(message: core.IRawOperationMessage) {
            throughput.produce();
            const sendP = producer.send(JSON.stringify(message), message.documentId);
            sendP.catch((error) => { return; }).then(() => throughput.acknolwedge());
            return sendP;
        }

        // Note connect is a reserved socket.io word so we use connectDocument to represent the connect request
        socket.on("connectDocument", (message: socketStorage.IConnect, response) => {
            // Join the room first to ensure the client will start receiving delta updates
            const profiler = winston.startTimer();
            connectionProfiler.done(`Client has requested to load ${message.id}`);

            /**
             * NOTE: Should there be an extra check to verify that if 'encrypted' is false, the passed keys are empty?
             * Food for thought: what should the correct behavior be if someone requests an encrypted connection to a
             * document that mongoDB has marked as unencrypted (or vice-versa)?
             */

            const documentDetailsP = storage.getOrCreateDocument(
                mongoManager,
                documentsCollectionName,
                message.id,
                message.privateKey,
                message.publicKey);

            documentDetailsP.then(
                (documentDetails) => {
                    socket.join(message.id).then(() => {
                        // Create and set a new client ID
                        const clientId = moniker.choose();
                        connectionsMap[clientId] = message.id;

                        // Broadcast the client connection message
                        const rawMessage: core.IRawOperationMessage = {
                            clientId: null,
                            documentId: message.id,
                            operation: {
                                clientSequenceNumber: 0,
                                contents: clientId,
                                encrypted: false,
                                encryptedContents: null,
                                referenceSequenceNumber: 0,
                                timestamp: Date.now(),
                                traceId: null,
                                type: api.ClientJoin,
                            },
                            timestamp: Date.now(),
                            type: core.RawOperationType,
                            userId: null,
                        };
                        sendAndTrack(rawMessage);

                        // And return the connection information to the client
                        const connectedMessage: socketStorage.IConnected = {
                            clientId,
                            encrypted: documentDetails.docPrivateKey ? true : false,
                            existing: documentDetails.existing,
                            privateKey: documentDetails.docPrivateKey,
                            publicKey: documentDetails.docPublicKey,
                        };
                        profiler.done(`Loaded ${message.id}`);
                        response(null, connectedMessage);
                    },
                    (error) => {
                        if (error) {
                            return response(error, null);
                        }
                    });
                }, (error) => {
                    winston.error("Error fetching", error);
                    response(error, null);
                });
        });

        // Message sent when a new operation is submitted to the router
        socket.on("submitOp", (clientId: string, message: api.IDocumentMessage, response) => {
            // Verify the user has connected on this object id
            if (!connectionsMap[clientId]) {
                return response("Invalid client ID", null);
            }
            if (message.type === api.RoundTrip) {
                // End of tracking
                metricLogger.writeLatencyMetric(message.traceId, "", "ScriptoriumToAlfred", "E2E", message.timestamp)
                            .catch((error) => {
                    winston.error(error.stack);
                });
                return response(null, "Roundtrip message received");
            }

            const documentId = connectionsMap[clientId];
            const rawMessage: core.IRawOperationMessage = {
                clientId,
                documentId,
                operation: message,
                timestamp: Date.now(),
                type: core.RawOperationType,
                userId: null,
            };

            throughput.produce();
            // Starting tracking message from client.
            metricLogger.writeLatencyMetric(message.traceId, "", "ClientToAlfred", "E2E", message.timestamp)
                        .catch((error) => {
                winston.error(error.stack);
            });
            metricLogger.writeLatencyMetric(message.traceId, "Alfred", "ClientToAlfred", "", Date.now())
                        .catch((error) => {
                winston.error(error.stack);
            });
            sendAndTrack(rawMessage).then(
                (responseMessage) => {
                    // Track Alfred end.
                    metricLogger.writeLatencyMetric(message.traceId, "Alfred", "AlfredToDeli", "", Date.now())
                                .catch((error) => {
                        winston.error(error.stack);
                    });
                    response(null, responseMessage);
                },
                (error) => {
                    winston.error(error);
                    response(error, null);
                });
        });

        socket.on("disconnect", () => {
            // Send notification messages for all client IDs in the connection map
            // tslint:disable-next-line:forin
            for (const clientId in connectionsMap) {
                const documentId = connectionsMap[clientId];
                const rawMessage: core.IRawOperationMessage = {
                    clientId: null,
                    documentId,
                    operation: {
                        clientSequenceNumber: -1,
                        contents: clientId,
                        encrypted: false,
                        encryptedContents: null,
                        referenceSequenceNumber: -1,
                        timestamp: Date.now(),
                        traceId: null,
                        type: api.ClientLeave,
                    },
                    timestamp: Date.now(),
                    type: core.RawOperationType,
                    userId: null,
                };

                sendAndTrack(rawMessage);
            }
        });
    });
}
