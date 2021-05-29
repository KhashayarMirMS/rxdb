import {
    getDocFromPouchOrNull,
    wasRevisionfromPullReplication,
    GRAPHQL_REPLICATION_PLUGIN_IDENT
} from './helper';
import type {
    RxCollection,
    PouchChangeRow,
    PouchChangeDoc,
    PouchdbChangesResult
} from '../../types';
import {
    POUCHDB_LOCAL_PREFIX,
    pouchSwapIdToPrimary
} from '../../rx-storage-pouchdb';
import { findLocalDocument, writeSingleLocal } from '../../rx-storage-helper';

/**
 * when the replication starts,
 * we need a way to find out where it ended the last time.
 *
 * For push-replication, we use the pouchdb-sequence:
 * We get the documents newer then the last sequence-id
 * and push them to the server.
 *
 * For pull-replication, we use the last document we got from the server:
 * We send the last document to the queryBuilder()
 * and recieve newer documents sorted in a batch
 */



//
// things for the push-checkpoint
//

const pushSequenceId = (endpointHash: string) => GRAPHQL_REPLICATION_PLUGIN_IDENT + '-push-checkpoint-' + endpointHash;

/**
 * @return last sequence checkpoint
 */
export async function getLastPushSequence(
    collection: RxCollection,
    endpointHash: string
): Promise<number> {

    const doc = await findLocalDocument(
        collection.localDocumentsStore,
        pushSequenceId(endpointHash)
    );
    if (!doc) {
        return 0;
    } else {
        return doc.value;
    }
}

export async function setLastPushSequence(
    collection: RxCollection,
    endpointHash: string,
    seq: any
): Promise<{ _id: string; value: number; _rev: string }> {
    const _id = pushSequenceId(endpointHash);

    let doc: any = await findLocalDocument(
        collection.localDocumentsStore,
        _id
    );
    if (!doc) {
        doc = {
            _id,
            value: seq
        };
    } else {
        doc.value = seq;
    }

    const res = await writeSingleLocal(
        collection.localDocumentsStore,
        false,
        doc
    );
    return res as any;
}


export async function getChangesSinceLastPushSequence<RxDocType>(
    collection: RxCollection<RxDocType>,
    endpointHash: string,
    lastPulledRevField: string,
    batchSize = 10,
    syncRevisions: boolean = false,
): Promise<{
    results: (PouchChangeRow & PouchChangeDoc)[];
    last_seq: number;
}> {
    let lastPushSequence = await getLastPushSequence(
        collection,
        endpointHash
    );

    let retry = true;
    let changes;

    /**
     * it can happen that all docs in the batch
     * do not have to be replicated.
     * Then we have to continue grapping the feed
     * until we reach the end of it
     */
    while (retry) {
        changes = await collection.pouch.changes({
            since: lastPushSequence,
            limit: batchSize,
            include_docs: true
            // style: 'all_docs'
        } as any);
        const filteredResults = changes.results.filter((change: any) => {
            /**
             * filter out changes with revisions resulting from the pull-stream
             * so that they will not be upstreamed again
             */
            if (wasRevisionfromPullReplication(
                endpointHash,
                change.doc._rev
            )) return false;

            if (change.doc[lastPulledRevField] === change.doc._rev) return false;
            /**
             * filter out internal docs
             * that are used for views or indexes in pouchdb
             */
            if (change.id.startsWith('_design/')) return false;

            return true;
        });

        let useResults = filteredResults;

        if (filteredResults.length > 0 && syncRevisions) {
            const docsSearch = filteredResults.map((result: any) => {
                return {
                    id: result.id,
                    rev: result.doc._rev
                };
            });

            const bulkGetDocs = await collection.pouch.bulkGet({
                docs: docsSearch,
                revs: true,
                latest: true
            });

            useResults = bulkGetDocs.results.map((result: any) => {
                return {
                    id: result.id,
                    doc: result.docs[0]['ok'],
                    deleted: result.docs[0]['ok']._deleted
                };
            }) as any;
        }

        if (useResults.length === 0 && changes.results.length === batchSize) {
            // no pushable docs found but also not reached the end -> re-run
            lastPushSequence = changes.last_seq;
            retry = true;
        } else {
            changes.results = useResults;
            retry = false;
        }
    }

    (changes as PouchdbChangesResult).results.forEach((change: any) => {
        change.doc = collection._handleFromPouch(change.doc);

        // TODO primary resolution should happen inside of the rx-storage-pouch
        change.doc = pouchSwapIdToPrimary(collection.schema.primaryPath, change.doc);
    });

    return changes as any;
}


//
// things for pull-checkpoint
//


const pullLastDocumentId = (endpointHash: string) => GRAPHQL_REPLICATION_PLUGIN_IDENT + '-pull-checkpoint-' + endpointHash;

export async function getLastPullDocument(
    collection: RxCollection,
    endpointHash: string
) {
    const localDoc = await findLocalDocument(
        collection.localDocumentsStore,
        pullLastDocumentId(endpointHash)
    );
    if (!localDoc) {
        return null;
    } else {
        return localDoc.doc;
    }
}

export async function setLastPullDocument(
    collection: RxCollection,
    endpointHash: string,
    doc: any
): Promise<{ _id: string }> {
    const _id = pullLastDocumentId(endpointHash);

    const localDoc = await findLocalDocument(
        collection.localDocumentsStore,
        _id
    );

    if (!localDoc) {
        return writeSingleLocal(
            collection.localDocumentsStore,
            false,
            {
                _id,
                doc
            }
        );
    } else {
        localDoc.doc = doc;
        return writeSingleLocal(
            collection.localDocumentsStore,
            false,
            localDoc as any
        );
    }
}
