import { IDocumentService } from "@prague/container-definitions";
import { ITestDeltaConnectionServer } from "./testDeltaConnectionServer";
import { TestDocumentService } from "./testDocumentService";

export function createTestDocumentService(testDeltaConnectionServer: ITestDeltaConnectionServer): IDocumentService {
    const service = new TestDocumentService(testDeltaConnectionServer);
    return service;
}
