/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IFluidCodeDetails } from "@prague/container-definitions";
import { extractDetails, WebCodeLoader } from "@prague/loader-web";
import { ScopeType } from "@prague/protocol-definitions";
import { IAlfredTenant } from "@prague/services-core";
import { Router } from "express";
import * as safeStringify from "json-stringify-safe";
import * as jwt from "jsonwebtoken";
import * as _ from "lodash";
import { Provider } from "nconf";
import { parse } from "url";
import { v4 } from "uuid";
import * as winston from "winston";
import { spoEnsureLoggedIn } from "../gateway-odsp-utils";
import { resolveUrl } from "../gateway-urlresolver";
import { IAlfred } from "../interfaces";
import { KeyValueWrapper } from "../keyValueWrapper";
import { getConfig, getParam, getUserDetails } from "../utils";
import { defaultPartials } from "./partials";

export function create(
    config: Provider,
    alfred: IAlfred,
    appTenants: IAlfredTenant[],
    ensureLoggedIn: any,
    cache: KeyValueWrapper): Router {

    const router: Router = Router();
    const jwtKey = config.get("gateway:key");
    const webLoader = new WebCodeLoader(config.get(config.get("worker:npm")));

    /**
     * Looks up the version of a chaincode in the cache.
     */
    async function getUrlWithVersion(chaincode: string): Promise<string> {
        return new Promise<string>((resolve) => {
            if (chaincode !== "" && chaincode.indexOf("@") === chaincode.lastIndexOf("@")) {
                cache.get(chaincode).then((value) => {
                    resolve(value as string);
                }, (err) => {
                    winston.error(err);
                    resolve(undefined);
                });
            } else {
                resolve(undefined);
            }
        });
    }

    /**
     * Loading of a specific fluid document.
     */
    router.get("/:tenantId/*", spoEnsureLoggedIn(), ensureLoggedIn(), (request, response) => {
        const start = Date.now();
        const chaincode: string = request.query.chaincode ? request.query.chaincode : "";
        getUrlWithVersion(chaincode).then((version: string) => {
            if (version) {
                const redirectUrl = `${request.originalUrl}@${version}`;
                winston.info(`Redirecting to ${redirectUrl}`);
                response.redirect(redirectUrl);
            } else {
                const jwtToken = jwt.sign(
                    {
                        user: request.user,
                    },
                    jwtKey);

                const rawPath = request.params[0] as string;
                const slash = rawPath.indexOf("/");
                const documentId = rawPath.substring(0, slash !== -1 ? slash : rawPath.length);
                const path = rawPath.substring(slash !== -1 ? slash : rawPath.length);

                const tenantId = getParam(request.params, "tenantId");

                const search = parse(request.url).search;
                const scopes = [ScopeType.DocRead, ScopeType.DocWrite, ScopeType.SummaryWrite];
                const [resolvedP, fullTreeP] =
                    resolveUrl(config, alfred, appTenants, tenantId, documentId, scopes, request);

                const workerConfig = getConfig(
                    config.get("worker"),
                    tenantId,
                    config.get("error:track"));

                const pkgP = fullTreeP.then((fullTree) => {
                    if (fullTree && fullTree.code) {
                        return webLoader.resolve(fullTree.code);
                    }

                    if (!request.query.chaincode) {
                        return;
                    }

                    const cdn = request.query.cdn ? request.query.cdn : config.get("worker:npm");
                    const entryPoint = request.query.entrypoint;

                    let codeDetails: IFluidCodeDetails;
                    if (chaincode.indexOf("http") === 0) {
                        codeDetails = {
                            config: {
                                [`@gateway:cdn`]: chaincode,
                            },
                            package: {
                                fluid: {
                                    browser: {
                                        umd: {
                                            files: [chaincode],
                                            library: entryPoint,
                                        },
                                    },
                                },
                                name: `@gateway/${v4()}`,
                                version: "0.0.0",
                            },
                        };
                    } else {
                        const details = extractDetails(chaincode);
                        codeDetails = {
                            config: {
                                [`@${details.scope}:cdn`]: cdn,
                            },
                            package: chaincode,
                        };
                    }

                    return webLoader.resolve(codeDetails);
                });

                const scriptsP = pkgP.then((pkg) => {
                    if (!pkg) {
                        return [];
                    }

                    const umd = pkg.pkg.fluid && pkg.pkg.fluid.browser && pkg.pkg.fluid.browser.umd;
                    if (!umd) {
                        return [];
                    }

                    return {
                        entrypoint: umd.library,
                        scripts: umd.files.map(
                            (script, index) => {
                                return {
                                    id: `${pkg.parsed.name}-${index}`,
                                    url: script.indexOf("http") === 0 ? script : `${pkg.packageUrl}/${script}`,
                                };
                            }),
                    };
                });

                // Track timing
                const treeTimeP = fullTreeP.then(() => Date.now() - start);
                const pkgTimeP = pkgP.then(() => Date.now() - start);
                const timingsP = Promise.all([treeTimeP, pkgTimeP]);

                Promise.all([resolvedP, fullTreeP, pkgP, scriptsP, timingsP])
                    .then(([resolved, fullTree, pkg, scripts, timings]) => {
                    resolved.url += path + (search ? search : "");
                    winston.info(`render ${tenantId}/${documentId} +${Date.now() - start}`);

                    timings.push(Date.now() - start);

                    response.render(
                        "loaderFramed",
                        {
                            cache: fullTree ? JSON.stringify(fullTree.cache) : undefined,
                            chaincode: JSON.stringify(pkg),
                            config: workerConfig,
                            jwt: jwtToken,
                            npm: config.get("worker:npm"),
                            partials: defaultPartials,
                            resolved: JSON.stringify(resolved),
                            scripts,
                            timings: JSON.stringify(timings),
                            title: documentId,
                            user: getUserDetails(request),
                        });
                }, (error) => {
                    response.status(400).end(safeStringify(error, undefined, 2));
                }).catch((error) => {
                    response.status(500).end(safeStringify(error, undefined, 2));
                });
            }
        });

    });

    return router;
}