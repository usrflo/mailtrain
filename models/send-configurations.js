'use strict';

const knex = require('../lib/knex');
const hasher = require('node-object-hash')();
const dtHelpers = require('../lib/dt-helpers');
const { enforce, filterObject } = require('../lib/helpers');
const interoperableErrors = require('../shared/interoperable-errors');
const shares = require('./shares');
const namespaceHelpers = require('../lib/namespace-helpers');
const {MailerType, getSystemSendConfigurationId} = require('../shared/send-configurations');
const contextHelpers = require('../lib/context-helpers');

const allowedKeys = new Set(['name', 'description', 'from_email', 'from_email_overridable', 'from_name', 'from_name_overridable', 'reply_to', 'reply_to_overridable', 'subject', 'subject_overridable', 'verp_hostname', 'mailer_type', 'mailer_settings', 'namespace']);

const allowedMailerTypes = new Set(Object.values(MailerType));

function hash(entity) {
    return hasher.hash(filterObject(entity, allowedKeys));
}

async function listDTAjax(context, params) {
    return await dtHelpers.ajaxListWithPermissions(
        context,
        [{ entityTypeId: 'sendConfiguration', requiredOperations: ['viewPublic'] }],
        params,
        builder => builder
            .from('send_configurations')
            .innerJoin('namespaces', 'namespaces.id', 'send_configurations.namespace'),
        ['send_configurations.id', 'send_configurations.name', 'send_configurations.description', 'send_configurations.mailer_type', 'send_configurations.created', 'namespaces.name']
    );
}

async function getByIdTx(tx, context, id, withPermissions = true, withPrivateData = true) {
    let entity;

    if (withPrivateData) {
        await shares.enforceEntityPermissionTx(tx, context, 'sendConfiguration', id, 'viewPrivate');
        entity = await tx('send_configurations').where('id', id).first();
        entity.mailer_settings = JSON.parse(entity.mailer_settings);
    } else {
        await shares.enforceEntityPermissionTx(tx, context, 'sendConfiguration', id, 'viewPublic');
        entity = await tx('send_configurations').where('id', id).select(
            ['id', 'name', 'description', 'from_email', 'from_email_overridable', 'from_name', 'from_name_overridable', 'reply_to', 'reply_to_overridable', 'subject', 'subject_overridable']
        ).first();
    }

    // note that permissions are optional as as this methods may be used with synthetic admin context
    if (withPermissions) {
        entity.permissions = await shares.getPermissionsTx(tx, context, 'sendConfiguration', id);
    }

    return entity;
}

async function getById(context, id, withPermissions = true, withPrivateData = true) {
    return await knex.transaction(async tx => {
        return await getByIdTx(tx, context, id, withPermissions, withPrivateData);
    });
}

async function _validateAndPreprocess(tx, entity, isCreate) {
    await namespaceHelpers.validateEntity(tx, entity);

    enforce(allowedMailerTypes.has(entity.mailer_type), 'Unknown mailer type');
    entity.mailer_settings = JSON.stringify(entity.mailer_settings);
}



async function create(context, entity) {
    return await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'namespace', entity.namespace, 'createSendConfiguration');

        await _validateAndPreprocess(tx, entity);

        const ids = await tx('send_configurations').insert(filterObject(entity, allowedKeys));
        const id = ids[0];

        await shares.rebuildPermissionsTx(tx, { entityTypeId: 'sendConfiguration', entityId: id });

        return id;
    });
}

async function updateWithConsistencyCheck(context, entity) {
    await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'list', entity.id, 'edit');

        const existing = await tx('send_configurations').where('id', entity.id).first();
        if (!existing) {
            throw new interoperableErrors.NotFoundError();
        }

        existing.mailer_settings = JSON.parse(existing.mailer_settings);

        const existingHash = hash(existing);
        if (existingHash !== entity.originalHash) {
            throw new interoperableErrors.ChangedError();
        }

        await _validateAndPreprocess(tx, entity);

        await namespaceHelpers.validateMove(context, entity, existing, 'sendConfiguration', 'createSendConfiguration', 'delete');

        await tx('send_configurations').where('id', entity.id).update(filterObject(entity, allowedKeys));

        await shares.rebuildPermissionsTx(tx, { entityTypeId: 'sendConfiguration', entityId: entity.id });
    });

    // FIXME - recreate respective mailer, notify senders to recreate the mailer

}

async function remove(context, id) {
    if (id === getSystemSendConfigurationId()) {
        shares.throwPermissionDenied();
    }

    await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'sendConfiguration', id, 'delete');

        // FIXME - delete send configuration assignment in campaigns
        await tx('lists').update({send_configuration: null}).where('send_configuration', id);

        await tx('send_configurations').where('id', id).del();
    });
}

async function getSystemSendConfiguration() {
    return await getById(contextHelpers.getAdminContext(), getSystemSendConfigurationId(), false);
}

module.exports = {
    MailerType,
    hash,
    listDTAjax,
    getByIdTx,
    getById,
    create,
    updateWithConsistencyCheck,
    remove,
    getSystemSendConfiguration
};