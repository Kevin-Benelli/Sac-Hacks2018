import React, { Component } from 'react';
import { Link } from 'react-router-dom';




class Home extends Component {
  render() {
    return (
      <div className="App">
        <h1>Api Request</h1>
        {/* Link to List.js */}
        <Link to={'./list'}>
          <button variant="raised">

          </button>
        </Link>
      </div>
    );
  }
}
export default Home;