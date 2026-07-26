/**
 * Barrel da CADEIA de entidade fiscal compartilhada (skill
 * cadastro-entidade-fiscal.md). Consumidores da cadeia (institutions,
 * futuros customers/providers/collaborators/banks) importam de
 * '@shared/entity'.
 *
 * Cada peça vive na SUA pasta sob src/shared/ (address/, phone/,
 * social-media/, fiscal/) — ISP: quem precisa só de telefones importa
 * '@shared/phone/phone.repository' sem carregar a cadeia. Este barrel
 * re-exporta tudo por conveniência de quem consome a cadeia INTEIRA.
 */

export * from './entity.types'
export * from './entity.dto'
export * from './entity.repository'

export * from '../fiscal/fiscal.types'
export * from '../fiscal/fiscal.dto'
export * from '../fiscal/fiscal.repository'

export * from '../address/address.types'
export * from '../address/address.dto'
export * from '../address/address.repository'

export * from '../phone/phone.types'
export * from '../phone/phone.dto'
export * from '../phone/phone.repository'

export * from '../social-media/social-media.types'
export * from '../social-media/social-media.dto'
export * from '../social-media/social-media.repository'

export * from './entity-fiscal'
