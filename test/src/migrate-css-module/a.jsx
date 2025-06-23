import { useState } from 'react'
import classNames from 'classnames'
import './a.scss'

const A = (props) => {
  const [name, setName] = useState('world')
  const { className, level, disabled } = props

  retutn(
    <div className={`${className ? className : `page ${Number.MAX_VALUE}`} className`}>
      <h1 className='x text'>Hello {name}</h1>
      {/* 结果应该是：className={classNames(`${level}-tag`, 'tag', `left-${level}-right`)} 或 className={`${level}-tag tag left-${level}-right`} */}
      <div className={`${level}-tag tag left-${level}-right`} />
      {/* 结果应该是：className={classNames('icon', `icon-${level}`)} 或 className={`icon icon-${level}`} */}
      <div className={`icon icon-${level}`} />
      {/* 结果应该是：className={styles.card} */}
      <div className='card' />
      {/* 结果应该是：className={styles.card} */}
      <div className={'card'} />
      {/* 结果应该是：className={styles.card} */}
      <div className={`card`} />
      {/* 结果应该是：className={classNames(styles.card, 'bg-white')} */}
      <div className={'card  bg-white'} />
      {/* 结果应该是：className={classNames(styles.card, 'bg-white')} */}
      <div className={classNames('card  bg-white')} />
      {/* 结果应该是：className={classNames(styles.card, 'bg-white', {active: level})} */}
      <div className={classNames('card','bg-white', {active: level})} />
      {/* 结果应该是：className={classNames(styles.card, level ? styles.active : '')} */}
      <div className={`${level === '1' ? 'active ' : ' '} card`} />
      {/* 结果应该是：className={classNames(styles.card, level ? 'bg-white' : '', styles.colorRed)} */}
      <div className={'card ' + (level ? ' bg-white' : ' ') + (level ? 'button--primary' : 'button') + ' color--red'} />
      <div className='global-card'>
        <div className={classNames('btnWrap')}>
          <div className='text'>这个text是全局样式</div>
          <div className={className ? className + ' x' : ''}></div>
          <div className={className && className + ' x'}></div>
          <button
            className={classNames(
              'btn',
              'btn--primarty',
              `btn-primary a`,
              'button',
              styl.o,
              { 'button--disabled': disabled, 'btn': true },
              level === 'warning' && 'button--warning',
              [level === 'warning' && 'btn--warning', [a && 'button']],
              [level === 'error' ? 'button--disabled btn--error' : null],
              { 'btn--disabled': disabled, [styl.o]: true }
            )}
          >BUTTON</button>
        </div>
      </div>
      <div>
        <i className='at-icon at-icon-close' />
        <i className={`at-icon at-icon-${level ? 'svip' : 'profile'} color--red`} />
      </div>
    </div>
  )
}
